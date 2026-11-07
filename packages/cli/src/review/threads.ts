import { readDelivery } from "../delivery.ts";
import { describe, read } from "../read.ts";
import { readDeclarations, type Declaration } from "../reviewers/declaration.ts";
import type { CommandOutput, ReadResult } from "../round/types.ts";

export type GhRunner = (
  args: readonly string[],
  deadline?: number,
  input?: string,
) => Promise<ReadResult>;
export type Dependencies = {
  root: string;
  env: NodeJS.ProcessEnv;
  gh: GhRunner;
  stderr?: (text: string) => void;
};
export type ThreadComment = { url: string; login: string };
export type ThreadStarter = {
  login: string | null;
  body: string;
  createdAt: string;
  path: string | null;
  line: number | null;
};
export type Thread = {
  id: string;
  isResolved: boolean;
  starter: ThreadStarter | null;
  comments: ThreadComment[];
};
export type ThreadsRead = { viewer: string; threads: Thread[] };
type Page<Node> = {
  nodes: Node[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

export const threadSelection = `pageInfo { hasNextPage endCursor }
  nodes {
    id isResolved
    starter: comments(first: 1) @include(if: $starter) {
      nodes { body createdAt path line author { login } }
    }
    comments(first: 100) @skip(if: $starter) {
      pageInfo { hasNextPage endCursor }
      nodes { url author { login } }
    }
  }`;
export const threadsQuery = `query ReviewThreads($owner: String!, $repo: String!, $number: Int!, $after: String, $starter: Boolean!) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      headRefOid
      reviewThreads(first: 100, after: $after) {
        ${threadSelection}
      }
    }
  }
}`;
function nodeQuery(fields: string): string {
  return `query($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      isResolved
      comments(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { ${fields} }
      }
    }
  }
}`;
}

export const commentsQuery = nodeQuery("url author { login }");
export const bodiesQuery = nodeQuery("url body author { login }");
export const replyMutation = `mutation($id: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $id, body: $body}) { comment { url } }
}`;
export const resolveMutation = `mutation($id: ID!) {
  resolveReviewThread(input: {threadId: $id}) { thread { isResolved } }
}`;

type ErrorFactory = (detail: string) => Error;
const threadError: ErrorFactory = () => new Error("cannot read review threads");
function record(
  value: unknown,
  error: ErrorFactory = threadError,
  path = "review threads",
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw error(`invalid ${path}`);

  return value as Record<string, unknown>;
}

function text(value: unknown, error: ErrorFactory = threadError, path = "review threads"): string {
  if (typeof value !== "string" || !value) throw error(`invalid ${path}`);
  return value;
}

function comment(value: unknown): ThreadComment {
  const node = record(value);
  const login = node.author === null ? "ghost" : text(record(node.author).login);
  return { url: text(node.url), login };
}

function bodyComment(value: unknown): ThreadComment & { body: string } {
  const node = record(value);
  if (typeof node.body !== "string") throw new Error("cannot read review threads");
  return { ...comment(value), body: node.body };
}

function page<Node>(
  value: unknown,
  parse: (value: unknown) => Node,
  error: ErrorFactory = threadError,
): Page<Node> {
  const connection = record(value, error);
  const info = record(connection.pageInfo, error);
  if (
    !Array.isArray(connection.nodes) ||
    typeof info.hasNextPage !== "boolean" ||
    (info.endCursor !== null && typeof info.endCursor !== "string")
  )
    throw error("invalid reviewThreads.pageInfo or nodes");

  return {
    nodes: connection.nodes.map(parse),
    pageInfo: { hasNextPage: info.hasNextPage, endCursor: info.endCursor },
  };
}

function nextCursor<Node>(
  connection: Page<Node>,
  cursors: Set<string>,
  error: ErrorFactory = threadError,
): string | undefined {
  if (!connection.pageInfo.hasNextPage) return;

  const cursor = connection.pageInfo.endCursor;
  if (!cursor || cursors.has(cursor))
    throw error(`invalid reviewThreads.pageInfo.endCursor: ${JSON.stringify(cursor)}`);

  cursors.add(cursor);

  return cursor;
}

async function queryData(
  args: readonly string[],
  gh: GhRunner,
  stderr: (text: string) => void,
): Promise<Record<string, unknown>> {
  const response = await gh(["api", "graphql", ...args], 60_000);
  stderr(response.stderr);
  if (response.code !== 0) throw new Error("gh failed reading review threads");

  try {
    const result = record(JSON.parse(response.stdout));
    if (result.errors !== undefined && (!Array.isArray(result.errors) || result.errors.length))
      throw new Error("cannot read review threads");

    return record(result.data);
  } catch {
    throw new Error("cannot read review threads");
  }
}

async function readComments<Node>(
  id: string,
  initial: Page<Node>,
  query: string,
  parse: (value: unknown) => Node,
  gh: GhRunner,
  stderr: (text: string) => void,
): Promise<Node[]> {
  let connection = initial;
  const nodes = [...connection.nodes];
  const cursors = new Set<string>();

  let cursor: string | undefined;
  while ((cursor = nextCursor(connection, cursors)) !== undefined) {
    const data = await queryData(
      ["-f", `id=${id}`, "-f", `cursor=${cursor}`, "-f", `query=${query}`],
      gh,
      stderr,
    );

    const node = record(data.node);
    if (typeof node.isResolved !== "boolean") throw new Error("cannot read review threads");

    connection = page(node.comments, parse);
    nodes.push(...connection.nodes);
  }

  return nodes;
}

function starter(value: unknown, error: ErrorFactory): ThreadStarter | null {
  const connection = record(value, error, "review thread.starter");
  if (!Array.isArray(connection.nodes)) throw error("invalid review thread.starter.nodes");
  if (connection.nodes.length === 0) return null;

  const node = record(connection.nodes[0], error, "review thread.starter");
  if (
    typeof node.body !== "string" ||
    typeof node.createdAt !== "string" ||
    (node.path !== null && typeof node.path !== "string") ||
    (node.line !== null && !Number.isInteger(node.line))
  )
    throw error("invalid review thread.starter");

  return {
    login: node.author === null ? null : text(record(node.author, error).login, error),
    body: node.body,
    createdAt: node.createdAt,
    path: node.path,
    line: node.line as number | null,
  };
}

export async function collectThreads(
  firstPage: unknown,
  nextPage: (cursor: string) => Promise<unknown>,
  error: ErrorFactory = threadError,
  comments?: (id: string, initial: Page<ThreadComment>) => Promise<ThreadComment[]>,
): Promise<Thread[]> {
  const cursors = new Set<string>();
  const threads: Thread[] = [];

  let value = firstPage;
  while (true) {
    const connection = page(
      value,
      (value) => {
        const node = record(value, error);
        if (typeof node.isResolved !== "boolean") throw error("invalid review thread.isResolved");

        return {
          id: text(node.id, error),
          isResolved: node.isResolved,
          starter: comments === undefined ? starter(node.starter, error) : null,
          comments: comments === undefined ? null : page(node.comments, comment, error),
        };
      },
      error,
    );

    for (const node of connection.nodes)
      threads.push({
        id: node.id,
        isResolved: node.isResolved,
        starter: node.starter,
        comments:
          comments !== undefined && node.comments !== null
            ? await comments(node.id, node.comments)
            : [],
      });

    const cursor = nextCursor(connection, cursors, error);
    if (cursor === undefined) return threads;

    value = await nextPage(cursor);
  }
}

export async function readThreads(
  number: string,
  gh: GhRunner,
  stderr: (text: string) => void = () => {},
): Promise<ThreadsRead> {
  const base = ["-F", "owner={owner}", "-F", "repo={repo}", "-F", `number=${number}`];
  let viewer = "";
  const readPage = async (cursor?: string) => {
    const data = await queryData(
      [
        ...base,
        "-F",
        "starter=false",
        ...(cursor ? ["-f", `after=${cursor}`] : []),
        "-f",
        `query=${threadsQuery}`,
      ],
      gh,
      stderr,
    );

    const login = text(record(data.viewer).login);
    if (viewer && viewer !== login) throw new Error("cannot read review threads");

    viewer = login;

    const pr = record(record(data.repository).pullRequest);
    return pr.reviewThreads;
  };

  const threads = await collectThreads(await readPage(), readPage, threadError, (id, initial) =>
    readComments(id, initial, commentsQuery, comment, gh, stderr),
  );

  return { viewer, threads };
}

async function readThread<Node>(
  id: string,
  query: string,
  parse: (value: unknown) => Node,
  gh: GhRunner,
  stderr: (text: string) => void,
): Promise<{ isResolved: boolean; comments: Node[] }> {
  const data = await queryData(["-f", `id=${id}`, "-f", `query=${query}`], gh, stderr);
  const node = record(data.node);
  if (typeof node.isResolved !== "boolean") throw new Error("cannot read review threads");

  const comments = await readComments(id, page(node.comments, parse), query, parse, gh, stderr);
  return { isResolved: node.isResolved, comments };
}

export function readThreadComments(
  id: string,
  gh: GhRunner,
  stderr: (text: string) => void = () => {},
): Promise<{ isResolved: boolean; comments: ThreadComment[] }> {
  return readThread(id, commentsQuery, comment, gh, stderr);
}

export function readThreadBodies(
  id: string,
  gh: GhRunner,
  stderr: (text: string) => void = () => {},
): Promise<{ isResolved: boolean; comments: (ThreadComment & { body: string })[] }> {
  return readThread(id, bodiesQuery, bodyComment, gh, stderr);
}

export function declarations(deps: Dependencies): Declaration[] {
  try {
    return readDeclarations(deps.root);
  } catch (error) {
    deps.stderr?.(`${error instanceof Error ? error.message : String(error)}\n`);
    throw new Error("cannot read reviewer declarations");
  }
}

export function activeReviewers(
  installed: readonly Declaration[],
  deps: Dependencies,
  verb: "reply" | "resolve",
): { names: string; logins: Set<string> } {
  const delivery = readDelivery(deps.root, deps.env);
  const active = installed.filter(
    (entry) => delivery.mode === "prs" && delivery.active.includes(entry.name),
  );

  if (!active.length) {
    if (!installed.length) throw new Error("no reviewer is installed");

    throw new Error(
      installed.map((entry) => `${entry.name} is not active in prs mode`).join(`\n${verb}: `),
    );
  }

  return {
    names: active.map((entry) => entry.displayName).join(" or "),
    logins: new Set(active.flatMap((entry) => entry.logins.map((login) => login.toLowerCase()))),
  };
}

export function validUrl(number: string, url: string): boolean {
  return new RegExp(`^https://.*/pull/${number}#discussion_r[0-9]+$`).test(url);
}

export async function runReview(
  prefix: string,
  usage: string,
  deps: Dependencies,
  execute: (output: CommandOutput, deps: Dependencies) => Promise<void>,
): Promise<CommandOutput> {
  const output: CommandOutput = { code: 0, stdout: "", stderr: "" };
  const stderr = (text: string) => {
    output.stderr += text;
    deps.stderr?.(text);
  };

  try {
    await execute(output, { ...deps, stderr });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.code = message === usage ? 2 : 1;
    stderr(message === usage ? `${usage}\n` : `${prefix}: ${message}\n`);
  }

  return output;
}

export function dependencies(
  root: string,
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Dependencies {
  return {
    root,
    env,
    gh: async (args, deadline, input) => {
      if (deadline !== undefined) {
        const result = await read(["gh", ...args], { cwd, env, deadline });
        return result.ok
          ? { code: result.code, stdout: result.stdout, stderr: result.stderr }
          : {
              code: -1,
              stdout: "",
              stderr: describe(result.failure) + "\n",
              failure: result.failure,
            };
      }

      const child = Bun.spawn(["gh", ...args], {
        cwd,
        env,
        stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      return { stdout, stderr, code };
    },
  };
}

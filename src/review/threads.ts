import { readDelivery } from "../delivery.ts";
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
export type Thread = { id: string; isResolved: boolean; comments: ThreadComment[] };
export type ThreadsRead = { viewer: string; threads: Thread[] };
type Page<Node> = {
  nodes: Node[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

export const threadsQuery = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved
          comments(first: 100) {
            pageInfo { hasNextPage endCursor }
            nodes { url author { login } }
          }
        }
      }
    }
  }
}`;
export const commentsQuery = `query($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { url author { login } }
      }
    }
  }
}`;
export const bodiesQuery = commentsQuery.replace(
  "nodes { url author",
  "nodes { url body author",
);
export const replyMutation = `mutation($id: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $id, body: $body}) { comment { url } }
}`;
export const resolveMutation = `mutation($id: ID!) {
  resolveReviewThread(input: {threadId: $id}) { thread { isResolved } }
}`;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("cannot read review threads");

  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("cannot read review threads");
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

function page<Node>(value: unknown, parse: (value: unknown) => Node): Page<Node> {
  const connection = record(value);
  const info = record(connection.pageInfo);
  if (
    !Array.isArray(connection.nodes) ||
    typeof info.hasNextPage !== "boolean" ||
    (info.endCursor !== null && typeof info.endCursor !== "string")
  )
    throw new Error("cannot read review threads");

  return {
    nodes: connection.nodes.map(parse),
    pageInfo: { hasNextPage: info.hasNextPage, endCursor: info.endCursor },
  };
}

function nextCursor<Node>(connection: Page<Node>, cursors: Set<string>): string | undefined {
  if (!connection.pageInfo.hasNextPage) return;

  const cursor = connection.pageInfo.endCursor;
  if (!cursor || cursors.has(cursor)) throw new Error("cannot read review threads");

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

    connection = page(record(data.node).comments, parse);
    nodes.push(...connection.nodes);
  }

  return nodes;
}

export async function readThreads(
  number: string,
  gh: GhRunner,
  stderr: (text: string) => void = () => {},
): Promise<ThreadsRead> {
  const base = ["-F", "owner={owner}", "-F", "repo={repo}", "-F", `number=${number}`];
  const cursors = new Set<string>();
  const threads: Thread[] = [];

  let viewer = "";
  let cursor: string | undefined;
  do {
    const data = await queryData(
      [...base, ...(cursor ? ["-f", `after=${cursor}`] : []), "-f", `query=${threadsQuery}`],
      gh,
      stderr,
    );

    const login = text(record(data.viewer).login);
    if (viewer && viewer !== login) throw new Error("cannot read review threads");

    viewer = login;

    const pr = record(record(data.repository).pullRequest);
    const connection = page(pr.reviewThreads, (value) => {
      const node = record(value);
      if (typeof node.isResolved !== "boolean") throw new Error("cannot read review threads");

      return {
        id: text(node.id),
        isResolved: node.isResolved,
        comments: page(node.comments, comment),
      };
    });

    for (const node of connection.nodes)
      threads.push({
        id: node.id,
        isResolved: node.isResolved,
        comments: await readComments(
          node.id,
          node.comments,
          commentsQuery,
          comment,
          gh,
          stderr,
        ),
      });

    cursor = nextCursor(connection, cursors);
  } while (cursor !== undefined);

  return { viewer, threads };
}

export async function readBodies(
  id: string,
  gh: GhRunner,
  stderr: (text: string) => void = () => {},
): Promise<(ThreadComment & { body: string })[]> {
  const data = await queryData(["-f", `id=${id}`, "-f", `query=${bodiesQuery}`], gh, stderr);
  const initial = page(record(data.node).comments, bodyComment);
  return readComments(id, initial, bodiesQuery, bodyComment, gh, stderr);
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
    logins: new Set(
      active.flatMap((entry) => entry.logins.map((login) => login.toLowerCase())),
    ),
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
      const child = Bun.spawn(["gh", ...args], {
        cwd,
        env,
        stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
        stdout: "pipe",
        stderr: "pipe",
        ...(deadline ? { timeout: deadline, killSignal: "SIGKILL" } : {}),
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

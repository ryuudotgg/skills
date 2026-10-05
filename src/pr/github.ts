import { describe, read } from "../read.ts";
import { collectThreads, threadSelection, threadsQuery, type Thread } from "../review/threads.ts";
import type { ReviewerDeclarations } from "./types.ts";
import type * as T from "./types.ts";
import { nonEmpty, parsePrNumber } from "./types.ts";
export const OPEN_PULL_REQUEST_LIMIT = 300;
const contextsSelection = `contexts(first: 100, after: $after) {
  pageInfo { hasNextPage endCursor }
  nodes {
    __typename
    ... on CheckRun {
      databaseId name title status conclusion detailsUrl
      checkSuite { app { slug } workflowRun { event workflow { name } } }
    }
    ... on StatusContext { context state description targetUrl }
  }
}`;
export const PR_POLL_QUERY = `query PrPoll($owner: String!, $repo: String!, $number: Int!, $after: String, $starter: Boolean!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      state mergedAt isDraft mergeable mergeStateStatus reviewDecision headRefOid headRefName baseRefName
      commits(last: 50) { nodes { commit { oid statusCheckRollup { state } } } }
      head: commits(last: 1) { nodes { commit { oid statusCheckRollup { ${contextsSelection} } } } }
      reviewThreads(first: 100) { ${threadSelection} }
    }
  }
}`;
export const PR_CHECK_ROLLUP_QUERY = `query PrCheckRollup($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      headRefOid
      head: commits(last: 1) { nodes { commit { oid statusCheckRollup { ${contextsSelection} } } } }
    }
  }
}`;

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
export class WatcherQueryError extends Error {
  readonly failure: T.QueryFailure;
  constructor(failure: T.QueryFailure) {
    super(failure.detail);
    this.name = "WatcherQueryError";
    this.failure = failure;
  }
}
export class ChecksUnavailable extends WatcherQueryError {
  constructor(detail: string) {
    super({ kind: "checks-unavailable", retryable: true, detail });
    this.name = "ChecksUnavailable";
  }
}
const firstLine = (value: string): string => value.trim().split(/\r?\n/, 1)[0]?.slice(0, 240) ?? "";
export function commandRunner(
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
): (argv: readonly [string, ...string[]], deadline?: number) => Promise<CommandResult> {
  return async (argv, deadline = 60_000) => {
    const result = await read(argv, { ...options, deadline });
    if (!result.ok)
      throw new WatcherQueryError({
        kind: "read-failed",
        retryable: result.failure.kind === "deadline" || result.failure.kind === "signal",
        detail: describe(result.failure),
      });

    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  };
}

const run = commandRunner();
function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new WatcherQueryError({
      kind: "json-parse",
      retryable: true,
      detail: `${label}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}
function raw(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
function missing(path: string, value?: unknown): never {
  throw new WatcherQueryError({
    kind: "missing-key",
    retryable: true,
    detail: value === undefined ? `missing ${path}` : `invalid ${path}: ${raw(value)}`,
    ...(value === undefined ? {} : { rawValue: raw(value) }),
  });
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) missing(path, value);
  return value;
}
function list(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) missing(path, value);
  return value;
}
function at(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    const object = record(current, path.join("."));
    if (!(key in object)) missing(path.join("."));
    current = object[key];
  }

  return current;
}
function string(value: unknown, path: string): string {
  if (typeof value !== "string") missing(path, value);
  return value;
}
const optionalString = (value: unknown, path: string): string | null =>
  value === null ? null : string(value, path);
function enumValue<const V extends readonly string[]>(
  value: unknown,
  values: V,
  path: string,
): V[number] {
  if (typeof value === "string")
    for (const candidate of values) if (candidate === value) return candidate;

  return missing(path, value);
}
const nullableEnum = <const V extends readonly string[]>(
  value: unknown,
  values: V,
  path: string,
): V[number] | null => (value === null ? null : enumValue(value, values, path));
const MERGE_STATES = [
  "BEHIND",
  "BLOCKED",
  "CLEAN",
  "CONFLICTING",
  "DIRTY",
  "DRAFT",
  "HAS_HOOKS",
  "UNKNOWN",
  "UNSTABLE",
] as const satisfies readonly T.MergeStateStatus[];
const ROLLUP_STATES = ["ERROR", "EXPECTED", "FAILURE", "PENDING", "SUCCESS"] as const;
const REVIEW_DECISIONS = ["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"] as const;
const reviewDecision = (value: unknown): T.ReviewDecision =>
  nullableEnum(value === "" ? null : value, REVIEW_DECISIONS, "pull request.reviewDecision");
function parseRemote(value: string): T.Repository | null {
  let normalized = value.trim();
  if (normalized.startsWith("git@github.com:"))
    normalized = `https://github.com/${normalized.slice(15)}`;

  if (normalized.startsWith("ssh://git@github.com/"))
    normalized = `https://github.com/${normalized.slice(21)}`;

  try {
    const url = new URL(normalized);
    const parts = url.pathname
      .replace(/\.git$/, "")
      .split("/")
      .filter(Boolean);

    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      parts.length !== 2
    )
      return null;

    return { owner: parts[0]!, repo: parts[1]! };
  } catch {
    return null;
  }
}
function parsePrUrl(value: string): T.PrContext {
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      parts.length !== 4 ||
      parts[2] !== "pull"
    )
      throw new Error("not a canonical GitHub pull URL");

    return {
      owner: parts[0]!,
      repo: parts[1]!,
      number: parsePrNumber(Number(parts[3])),
    };
  } catch (error) {
    throw new WatcherQueryError({
      kind: "invalid-context-url",
      retryable: false,
      rawValue: value,
      detail: `could not infer owner/repo from PR URL: ${value} (${error instanceof Error ? error.message : String(error)})`,
    });
  }
}
function checkDetails(value: Record<string, unknown>, nameKey: string) {
  return {
    name: string(value[nameKey], nameKey),
    description: typeof value.description === "string" ? value.description : "",
    link:
      typeof value.link === "string"
        ? value.link
        : typeof value.detailsUrl === "string"
          ? value.detailsUrl
          : "",
    workflow: typeof value.workflow === "string" ? value.workflow : "",
  };
}
function pendingOrGate(
  details: {
    readonly name: string;
    readonly description: string;
    readonly link: string;
    readonly workflow: string;
  },
  reportedState: string,
): T.Check {
  return details.name === "Code Review Gate"
    ? {
        ...details,
        kind: "code-review-gate",
        name: "Code Review Gate",
        reportedState,
      }
    : { ...details, kind: "pending", reportedState };
}
export function mapRollupNode(value: unknown): T.Check | null {
  const object = record(value, "rollup node");
  const typename = object.__typename;
  if (typename !== "CheckRun" && typename !== "StatusContext") return null;

  const run = typename === "CheckRun" ? workflowRun(object) : null;
  const details = {
    ...checkDetails(object, typename === "CheckRun" ? "name" : "context"),
    description:
      typename === "StatusContext"
        ? typeof object.description === "string"
          ? object.description
          : ""
        : typeof object.title === "string"
          ? object.title
          : "",
    workflow:
      run === null || run.workflow === null
        ? ""
        : string(record(run.workflow, "workflow").name, "workflow.name"),
  };

  const link = typeof object.targetUrl === "string" ? object.targetUrl : details.link;
  if (typename === "CheckRun") {
    const status = typeof object.status === "string" ? object.status.toUpperCase() : "";

    const conclusion = typeof object.conclusion === "string" ? object.conclusion.toUpperCase() : "";

    if (status !== "COMPLETED") return pendingOrGate({ ...details, link }, "PENDING");

    if (conclusion === "SUCCESS")
      return { ...details, link, kind: "passed", reportedState: "SUCCESS" };

    if (conclusion === "NEUTRAL" || conclusion === "SKIPPED")
      return { ...details, link, kind: "skipped", reportedState: conclusion };

    return {
      ...details,
      link,
      kind: "failed",
      reportedState: conclusion === "ACTION_REQUIRED" ? conclusion : "FAILURE",
    };
  }

  const state = typeof object.state === "string" ? object.state.toUpperCase() : "";
  if (state === "PENDING" || state === "EXPECTED")
    return pendingOrGate({ ...details, link }, "PENDING");

  return state === "SUCCESS"
    ? { ...details, link, kind: "passed", reportedState: state }
    : { ...details, link, kind: "failed", reportedState: state || "FAILURE" };
}
const REVIEW_BOT_PHRASES = ["agentic security review", "confidence score"] as const;
function isReviewBot(comment: T.ReviewComment | null, reviewers: ReviewerDeclarations): boolean {
  if (comment === null) return false;

  const author = (comment.authorLogin ?? "").toLowerCase();

  if (reviewers.logins.some((login) => login.toLowerCase() === author)) return true;
  if (!author.endsWith("[bot]")) return false;

  const body = comment.body.toLowerCase();

  return [...REVIEW_BOT_PHRASES, ...reviewers.outsideDiffHeadings].some((phrase) =>
    body.includes(phrase.toLowerCase()),
  );
}
const PASS_WINDOW_MS = 5 * 60 * 1000;
function countPassesByTime(comments: readonly T.ReviewComment[]): number {
  const stamps = comments
    .map((comment) => Date.parse(comment.createdAt))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  const first = stamps[0];
  if (first === undefined) return 0;

  let passes = 1;
  let previous = first;
  for (const stamp of stamps.slice(1)) {
    if (stamp - previous > PASS_WINDOW_MS) passes += 1;
    previous = stamp;
  }

  return passes;
}
function passKey(comment: T.ReviewComment | null): string | null {
  if (comment === null) return null;

  for (const pattern of [/RUN_ID:\s*([a-zA-Z0-9_.:-]+)/, /REVIEW_ID:\s*([a-zA-Z0-9_.:-]+)/]) {
    const match = pattern.exec(comment.body);
    if (match?.[1]) return match[1];
  }

  return null;
}
export function parseReviewThreads(
  value: readonly Thread[],
  reviewers: ReviewerDeclarations,
): readonly T.ReviewThread[] {
  const threads = value.map((thread) => ({
    id: thread.id,
    resolved: thread.isResolved,
    firstComment:
      thread.starter === null
        ? null
        : {
            authorLogin: thread.starter.login,
            body: thread.starter.body,
            createdAt: thread.starter.createdAt,
            path: thread.starter.path,
            line: thread.starter.line,
          },
  }));

  const keys = new Set<string>();
  const keyless: T.ReviewComment[] = [];
  for (const thread of threads) {
    if (!isReviewBot(thread.firstComment, reviewers)) continue;

    const key = passKey(thread.firstComment);
    if (key === null) {
      if (thread.firstComment !== null) keyless.push(thread.firstComment);
    } else keys.add(key);
  }

  const passes = keys.size > 0 ? keys.size : countPassesByTime(keyless);
  return threads
    .filter((thread) => !thread.resolved)
    .map(({ id, firstComment }) => ({
      id,
      firstComment,
      isReviewBot: isReviewBot(firstComment, reviewers),
      reviewBotPasses: passes,
    }));
}
export function parsePullRequest(value: unknown, context: T.PrContext): T.PullRequestFacts {
  const object = record(value, "pull request");
  if (typeof object.isDraft !== "boolean") missing("pull request.isDraft", object.isDraft);

  return {
    context,
    mergeable: enumValue(
      object.mergeable,
      ["MERGEABLE", "CONFLICTING", "UNKNOWN"] as const,
      "pull request.mergeable",
    ),
    mergeStateStatus: enumValue(
      object.mergeStateStatus,
      MERGE_STATES,
      "pull request.mergeStateStatus",
    ),
    reviewDecision: reviewDecision(object.reviewDecision),
    headRefOid: optionalString(object.headRefOid, "pull request.headRefOid"),
    headRefName: string(object.headRefName, "pull request.headRefName"),
    baseRefName: string(object.baseRefName, "pull request.baseRefName"),
    state: enumValue(object.state, ["OPEN", "CLOSED", "MERGED"] as const, "pull request.state"),
    mergedAt: optionalString(object.mergedAt, "pull request.mergedAt"),
    isDraft: object.isDraft,
  };
}
function graphqlArgs(query: string, context: T.PrContext, after?: string): [string, ...string[]] {
  return [
    "gh",
    "api",
    "graphql",
    ...(after === undefined ? [] : ["-f", `after=${after}`]),
    "-f",
    `query=${query}`,
    "-f",
    `owner=${context.owner}`,
    "-f",
    `repo=${context.repo}`,
    "-F",
    `number=${context.number}`,
  ];
}

class HeadMoved extends Error {
  constructor(
    readonly before: string | null,
    readonly after: string | null,
  ) {
    super("head moved");
  }
}
function pullRequestData(value: unknown): Record<string, unknown> {
  const response = record(value, "GraphQL response");
  if (
    response.errors !== undefined &&
    (!Array.isArray(response.errors) || response.errors.length > 0)
  )
    missing("GraphQL errors", response.errors);

  return record(at(response, ["data", "repository", "pullRequest"]), "pull request");
}
function headContexts(pr: Record<string, unknown>, expected: string | null): unknown {
  const actual = optionalString(pr.headRefOid, "pull request.headRefOid");
  if (actual !== expected) throw new HeadMoved(expected, actual);

  const nodes = list(at(pr, ["head", "nodes"]), "head.nodes");
  if (nodes.length !== 1) missing("head.nodes", nodes);

  const commit = record(at(nodes[0], ["commit"]), "head.commit");
  const oid = string(commit.oid, "head.commit.oid");
  if (oid !== expected) throw new HeadMoved(expected, oid);

  return commit.statusCheckRollup === null ? null : at(commit, ["statusCheckRollup", "contexts"]);
}
function checkApp(node: Record<string, unknown>): string {
  const suite = node.checkSuite;
  if (suite === null || suite === undefined) return "";

  const app = record(suite, "checkSuite").app;
  return app === null || app === undefined
    ? ""
    : string(record(app, "checkSuite.app").slug, "checkSuite.app.slug");
}
function workflowRun(node: Record<string, unknown>): Record<string, unknown> | null {
  const suite = node.checkSuite;
  if (suite === null || suite === undefined) return null;

  const run = record(suite, "checkSuite").workflowRun;
  return run === null ? null : record(run, "checkSuite.workflowRun");
}
function deduplicateChecks(nodes: readonly unknown[]): readonly T.Check[] {
  const newest = new Map<string, { check: T.Check; created: number }>();
  for (const value of nodes) {
    const node = record(value, "rollup node");
    const check = mapRollupNode(node);
    if (check === null) continue;

    const run = node.__typename === "CheckRun" ? workflowRun(node) : null;
    const event = run === null ? "" : string(run.event, "workflowRun.event");
    const key = JSON.stringify(
      node.__typename === "CheckRun"
        ? ["CheckRun", checkApp(node), check.name, check.workflow, event]
        : ["StatusContext", check.name],
    );

    const created = node.__typename === "CheckRun" ? node.databaseId : 0;
    if (typeof created !== "number" || !Number.isInteger(created))
      missing("CheckRun.databaseId", created);

    const previous = newest.get(key);
    if (previous === undefined || created >= previous.created) newest.set(key, { check, created });
  }

  return [...newest.values()].map((entry) => entry.check);
}
function parseRollups(pr: Record<string, unknown>): readonly T.CommitRollup[] {
  return list(at(pr, ["commits", "nodes"]), "commits.nodes").map((item, index) => {
    const commit = record(at(item, ["commit"]), `commits[${index}].commit`);
    const rollup = commit.statusCheckRollup;
    return {
      oid: string(commit.oid, `commits[${index}].oid`),
      state:
        rollup === null
          ? null
          : nullableEnum(
              at(rollup, ["state"]),
              ROLLUP_STATES,
              `commits[${index}].statusCheckRollup.state`,
            ),
    };
  });
}
export class GhGitHubReader implements T.GitHubReader {
  constructor(
    private readonly reviewers: ReviewerDeclarations,
    private readonly runner: (
      argv: readonly [string, ...string[]],
      deadlineMs: number,
    ) => Promise<CommandResult> = run,
    private readonly budget: () => number = () => 60_000,
  ) {}
  private async query(argv: readonly [string, ...string[]]): Promise<unknown> {
    const result = await this.runner(argv, this.budget());
    if (result.code !== 0)
      throw new WatcherQueryError({
        kind: "command-exit",
        retryable: true,
        code: result.code,
        detail: firstLine(result.stderr) || `${argv.join(" ")} exited ${result.code}`,
      });

    return parseJson(result.stdout, argv.join(" "));
  }
  async originRepo(): Promise<T.Repository | null> {
    const result = await run(["git", "remote", "get-url", "origin"], this.budget());
    return result.code === 0 ? parseRemote(result.stdout) : null;
  }
  async currentPr(pr: T.PrNumber | null): Promise<T.PrContext> {
    const argv: [string, ...string[]] = ["gh", "pr", "view"];
    if (pr !== null) argv.push(String(pr));
    argv.push("--json", "number,url");

    const object = record(await this.query(argv), "current PR");
    const parsed = parsePrUrl(string(object.url, "current PR.url"));
    return { ...parsed, number: pr ?? parsePrNumber(object.number, "current PR.number") };
  }
  async read(context: T.PrContext): Promise<T.PrRead> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.readPoll(context);
      } catch (error) {
        if (!(error instanceof HeadMoved)) throw error;
        if (attempt === 0) continue;

        throw new WatcherQueryError({
          kind: "merge-state-unknown",
          retryable: true,
          detail: `head of #${context.number} moved from ${error.before} to ${error.after} during one poll`,
        });
      }
    }
  }
  private async readPoll(context: T.PrContext): Promise<T.PrRead> {
    const argv = graphqlArgs(PR_POLL_QUERY, context);
    argv.push("-F", "starter=true");

    const pr = pullRequestData(await this.query(argv));
    const facts = parsePullRequest(pr, context);
    if (facts.state !== "OPEN" || facts.mergedAt !== null)
      return { facts, checks: [], rollups: [], threads: [] };

    let connection = headContexts(pr, facts.headRefOid);
    const nodes: unknown[] = [];
    const cursors = new Set<string>();
    while (connection !== null) {
      const contexts = record(connection, "contexts");
      nodes.push(...list(contexts.nodes, "contexts.nodes"));

      const info = record(contexts.pageInfo, "contexts.pageInfo");
      if (typeof info.hasNextPage !== "boolean")
        missing("contexts.pageInfo.hasNextPage", info.hasNextPage);

      const cursor = optionalString(info.endCursor, "contexts.pageInfo.endCursor");
      if (!info.hasNextPage) break;
      if (!cursor || cursors.has(cursor)) missing("contexts.pageInfo.endCursor", cursor);

      cursors.add(cursor);
      const next = graphqlArgs(PR_CHECK_ROLLUP_QUERY, context, cursor);
      connection = headContexts(pullRequestData(await this.query(next)), facts.headRefOid);
    }

    const threads = await collectThreads(
      pr.reviewThreads,
      async (cursor) => {
        const next = graphqlArgs(threadsQuery, context, cursor);
        next.push("-F", "starter=true");

        const page = pullRequestData(await this.query(next));
        const actual = optionalString(page.headRefOid, "pull request.headRefOid");
        if (actual !== facts.headRefOid) throw new HeadMoved(facts.headRefOid, actual);

        return page.reviewThreads;
      },
      (detail) => new WatcherQueryError({ kind: "missing-key", retryable: true, detail }),
    );

    return {
      facts,
      checks: deduplicateChecks(nodes),
      rollups: parseRollups(pr),
      threads: parseReviewThreads(threads, this.reviewers),
    };
  }
  async openPullRequests(repository: T.Repository): Promise<readonly T.OpenPullRequest[]> {
    const value = await this.query([
      "gh",
      "pr",
      "list",
      "--repo",
      `${repository.owner}/${repository.repo}`,
      "--state",
      "open",
      "--limit",
      String(OPEN_PULL_REQUEST_LIMIT),
      "--json",
      "number,headRefName,baseRefName,isCrossRepository",
    ]);

    return list(value, "open PRs").map((item, index) => {
      const object = record(item, `open PRs[${index}]`);
      if (typeof object.isCrossRepository !== "boolean")
        missing(`open PRs[${index}].isCrossRepository`, object.isCrossRepository);

      return {
        number: parsePrNumber(object.number, `open PRs[${index}].number`),
        headRefName: string(object.headRefName, `open PRs[${index}].headRefName`),
        baseRefName: string(object.baseRefName, `open PRs[${index}].baseRefName`),
        isCrossRepository: object.isCrossRepository,
      };
    });
  }
}

export async function resolveContext(args: {
  readonly reader: T.GitHubReader;
  readonly owner: string | null;
  readonly repo: string | null;
  readonly pr: T.PrNumber | null;
}): Promise<T.PrContext> {
  if (args.pr !== null && args.owner !== null && args.repo !== null)
    return { owner: args.owner, repo: args.repo, number: args.pr };

  if (args.pr !== null) {
    const origin = await args.reader.originRepo();
    if (origin !== null)
      return {
        owner: args.owner ?? origin.owner,
        repo: args.repo ?? origin.repo,
        number: args.pr,
      };
  }

  const inferred = await args.reader.currentPr(args.pr);
  return {
    owner: args.owner ?? inferred.owner,
    repo: args.repo ?? inferred.repo,
    number: args.pr ?? inferred.number,
  };
}
export function orderStack(
  context: T.PrContext,
  open: readonly T.OpenPullRequest[],
): T.NonEmpty<T.PrContext> {
  const byNumber = new Map(open.map((pr) => [pr.number, pr]));
  const sameRepository = open.filter((pr) => !pr.isCrossRepository);
  const byHead = new Map(sameRepository.map((pr) => [pr.headRefName, pr]));
  const children = new Map<string, T.OpenPullRequest[]>();
  for (const pr of sameRepository)
    children.set(pr.baseRefName, [...(children.get(pr.baseRefName) ?? []), pr]);

  for (const values of children.values()) values.sort((a, b) => a.number - b.number);

  const start = byNumber.get(context.number);
  if (start === undefined || start.isCrossRepository) return [context];

  const down: T.OpenPullRequest[] = [];
  const visited = new Set<T.PrNumber>([start.number]);

  let current = start;
  while (byHead.has(current.baseRefName)) {
    const parent = byHead.get(current.baseRefName);
    if (parent === undefined) break;

    if (visited.has(parent.number)) {
      const path = [start, ...down];
      const cycle = path.slice(path.findIndex((pr) => pr.number === parent.number));
      throw new WatcherQueryError({
        kind: "read-failed",
        retryable: false,
        detail: `stack discovery found a base cycle among ${cycle.map((pr) => `#${pr.number}`).join(", ")}`,
      });
    }

    visited.add(parent.number);
    down.push(parent);
    current = parent;
  }

  const seen = new Set<T.PrNumber>([...down.map((pr) => pr.number), start.number]);

  const up: T.OpenPullRequest[] = [];
  const visit = (parent: T.OpenPullRequest): void => {
    for (const child of children.get(parent.headRefName) ?? []) {
      if (seen.has(child.number)) continue;

      seen.add(child.number);
      up.push(child);
      visit(child);
    }
  };

  visit(start);
  return (
    nonEmpty(
      [...down.reverse(), start, ...up].map((pr) => ({
        ...context,
        number: pr.number,
      })),
    ) ?? [context]
  );
}
export async function discoverStack(
  reader: T.GitHubReader,
  context: T.PrContext,
): Promise<T.NonEmpty<T.PrContext>> {
  const open = await reader.openPullRequests(context);
  if (open.length >= OPEN_PULL_REQUEST_LIMIT)
    throw new WatcherQueryError({
      kind: "read-failed",
      retryable: false,
      detail: `open PR listing reached its limit of ${OPEN_PULL_REQUEST_LIMIT} so the stack may be incomplete`,
    });

  return orderStack(context, open);
}

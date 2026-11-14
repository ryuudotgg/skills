import { readFileSync } from "node:fs";
import { splitlines } from "../hooks/text.ts";
import { exitFailure, readFailure, WatcherQueryError } from "../pr/github.ts";
import type { CheckRun, Comment, PullRequest, ReadResult, ReadRunner, Snapshot } from "./types.ts";

export const snapshotPath = `${import.meta.dir}/snapshot.graphql`;
export const snapshotQuery = readFileSync(snapshotPath, "utf8");
export const commentsQuery = `query($owner: String!, $repo: String!, $number: Int!, $cursor: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      comments(last: 100, before: $cursor) {
        pageInfo { hasPreviousPage startCursor }
        nodes { id author { __typename login } body createdAt updatedAt }
      }
    }
  }
}`;

type Response = { data?: { viewer?: { login?: unknown }; repository?: { pullRequest?: unknown } } };

function parse(response: string): Response {
  try {
    return JSON.parse(response) ?? {};
  } catch {
    throw new Error("cannot parse PR snapshot");
  }
}

function pullRequest(response: Response): PullRequest {
  const pr = response.data?.repository?.pullRequest as PullRequest | undefined;
  if (!pr || !Array.isArray(pr.comments?.nodes)) throw new Error("cannot parse PR snapshot");
  return pr;
}

function failed(result: ReadResult, argv: readonly string[] = ["gh", "api", "graphql"]): void {
  if (result.failure) throw readFailure(result.failure);
  if (result.code !== 0) throw exitFailure(result, argv);
}

const graphql = (number: string) => [
  "api",
  "graphql",
  "-F",
  "owner={owner}",
  "-F",
  "repo={repo}",
  "-F",
  `number=${number}`,
];

export async function readPullRequest(
  number: string,
  gh: ReadRunner,
  stderr: (text: string) => void = () => {},
): Promise<{ pr: PullRequest; viewer: string | null }> {
  const response = await gh([...graphql(number), "-F", `query=@${snapshotPath}`], 60_000);
  failed(response);
  if (response.stderr) stderr(response.stderr);

  const data = parse(response.stdout);
  const viewer = data.data?.viewer?.login;
  return { pr: pullRequest(data), viewer: typeof viewer === "string" ? viewer : null };
}

export async function readSnapshot(
  number: string,
  gh: ReadRunner,
  stderr: (text: string) => void = () => {},
  checkNames: readonly string[] = [],
  cached: readonly Comment[] = [],
): Promise<Snapshot & { unreadable: string[] }> {
  const { pr } = await readPullRequest(number, gh, stderr);
  let page = pr.comments;
  let comments = [...page.nodes];
  const cursors = new Set<string>();
  while (page.pageInfo?.hasPreviousPage) {
    const oldest = comments[0]?.id;
    const known = oldest ? cached.findIndex((comment) => comment.id === oldest) : -1;
    if (known >= 0 && known + comments.length === pr.comments.totalCount) {
      comments = [...cached.slice(0, known), ...comments];
      break;
    }

    const cursor = page.pageInfo.startCursor;
    if (!cursor || cursors.has(cursor)) throw new Error("cannot parse earlier PR comments");

    cursors.add(cursor);
    const earlier = await gh(
      [...graphql(number), "-f", `cursor=${cursor}`, "-f", `query=${commentsQuery}`],
      60_000,
    );

    failed(earlier);
    if (earlier.stderr) stderr(earlier.stderr);

    page = pullRequest(parse(earlier.stdout)).comments;
    if (!page.pageInfo) throw new Error("cannot parse earlier PR comments");

    comments = [...page.nodes, ...comments];
  }

  const headChecks: Snapshot["headChecks"] = {};
  const unreadable: string[] = [];
  const head = pr.commits.nodes.at(-1)?.commit;
  if (head?.statusCheckRollup?.contexts.pageInfo?.hasNextPage)
    await Promise.all(
      [...new Set(checkNames)].map(async (name) => {
        const note = (text: string) =>
          stderr(
            text
              .replace(/\n$/, "")
              .split("\n")
              .map((line) => `${name}: ${line}\n`)
              .join(""),
          );

        try {
          headChecks[name] = await readHeadChecks(head.oid, name, gh, note);
        } catch (error) {
          note(error instanceof Error ? error.message : String(error));
          if (!(error instanceof WatcherQueryError && !error.failure.retryable))
            unreadable.push(name);
        }
      }),
    );

  return { pr, comments, headChecks, unreadable };
}

async function readHeadChecks(
  oid: string,
  name: string,
  gh: ReadRunner,
  stderr: (text: string) => void,
): Promise<CheckRun[]> {
  const args = [
    "api",
    "--paginate",
    `repos/{owner}/{repo}/commits/${oid}/check-runs?check_name=${encodeURIComponent(name)}&per_page=100`,
    "--jq",
    ".check_runs[] | [.status, .conclusion, .started_at, .completed_at] | @json",
  ];

  const checks = await gh(args, 60_000);
  failed(checks, ["gh", ...args.slice(0, 3)]);
  if (checks.stderr) stderr(checks.stderr);

  try {
    return splitlines(checks.stdout)
      .filter((line) => line.trim())
      .map((line): CheckRun => {
        const row = JSON.parse(line);
        if (
          !Array.isArray(row) ||
          row.length !== 4 ||
          typeof row[0] !== "string" ||
          row.slice(1).some((field) => field !== null && typeof field !== "string")
        )
          throw new Error("invalid head check");

        return {
          __typename: "CheckRun",
          name,
          status: row[0].toUpperCase(),
          conclusion: row[1] ? row[1].toUpperCase() : null,
          startedAt: row[2],
          completedAt: row[3],
        };
      });
  } catch {
    throw new Error("cannot parse head checks");
  }
}

import { readFileSync } from "node:fs";
import { pyStrip, splitlines } from "../hooks/python-text.ts";
import type { CheckRun, Comment, PullRequest, ReadRunner, Snapshot } from "./types.ts";

export const snapshotPath = `${import.meta.dir}/snapshot.graphql`;
export const snapshotQuery = readFileSync(snapshotPath, "utf8");
export const commentsQuery = `query($owner: String!, $repo: String!, $number: Int!, $cursor: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      comments(last: 100, before: $cursor) {
        pageInfo { hasPreviousPage startCursor }
        nodes { id author { login } body createdAt updatedAt }
      }
    }
  }
}`;

function pullRequest(response: string): PullRequest {
  try {
    const data = JSON.parse(response);
    const pr = data?.data?.repository?.pullRequest;
    if (!pr || !Array.isArray(pr.comments?.nodes)) throw new Error("missing pull request");

    return pr;
  } catch {
    throw new Error("cannot parse PR snapshot");
  }
}

export async function readSnapshot(
  number: string,
  gh: ReadRunner,
  stderr: (text: string) => void = () => {},
  checkNames: readonly string[] = [],
  cached: readonly Comment[] = [],
): Promise<Snapshot> {
  const base = [
    "api",
    "graphql",
    "-F",
    "owner={owner}",
    "-F",
    "repo={repo}",
    "-F",
    `number=${number}`,
  ];

  const response = await gh([...base, "-F", `query=@${snapshotPath}`], 60_000);
  if (response.stderr) stderr(response.stderr);
  if (response.code !== 0) throw new Error("gh failed reading PR snapshot");

  const pr = pullRequest(response.stdout);
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
      [...base, "-f", `cursor=${cursor}`, "-f", `query=${commentsQuery}`],
      60_000,
    );

    if (earlier.stderr) stderr(earlier.stderr);
    if (earlier.code !== 0) throw new Error("gh failed reading earlier PR comments");

    page = pullRequest(earlier.stdout).comments;
    if (!page.pageInfo) throw new Error("cannot parse earlier PR comments");

    comments = [...page.nodes, ...comments];
  }

  const headChecks: Snapshot["headChecks"] = {};
  const head = pr.commits.nodes.at(-1)?.commit;
  if (head?.statusCheckRollup?.contexts.pageInfo?.hasNextPage)
    for (const name of new Set(checkNames)) {
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
      }
    }

  return { pr, comments, headChecks };
}

async function readHeadChecks(
  oid: string,
  name: string,
  gh: ReadRunner,
  stderr: (text: string) => void,
): Promise<CheckRun[]> {
  const checks = await gh(
    [
      "api",
      "--paginate",
      `repos/{owner}/{repo}/commits/${oid}/check-runs?check_name=${encodeURIComponent(name)}&per_page=100`,
      "--jq",
      ".check_runs[] | [.status, .conclusion, .started_at] | @json",
    ],
    60_000,
  );

  if (checks.stderr) stderr(checks.stderr);
  if (checks.code !== 0) throw new Error("gh failed reading head checks");

  try {
    return splitlines(checks.stdout)
      .filter((line) => pyStrip(line))
      .map((line): CheckRun => {
        const row = JSON.parse(line);
        if (
          !Array.isArray(row) ||
          row.length !== 3 ||
          typeof row[0] !== "string" ||
          (row[1] !== null && typeof row[1] !== "string") ||
          (row[2] !== null && typeof row[2] !== "string")
        )
          throw new Error("invalid head check");

        return {
          __typename: "CheckRun",
          name,
          status: row[0].toUpperCase(),
          conclusion: row[1] ? row[1].toUpperCase() : null,
          startedAt: row[2],
        };
      });
  } catch {
    throw new Error("cannot parse head checks");
  }
}

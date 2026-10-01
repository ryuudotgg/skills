import { readFileSync } from "node:fs";
import type { PullRequest, ReadRunner, Snapshot } from "./types.ts";

export const snapshotPath = `${import.meta.dir}/snapshot.graphql`;
export const snapshotQuery = readFileSync(snapshotPath, "utf8");
export const commentsQuery = `query($owner: String!, $repo: String!, $number: Int!, $cursor: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      comments(last: 100, before: $cursor) {
        pageInfo { hasPreviousPage startCursor }
        nodes { author { login } body createdAt }
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

  return { pr, comments };
}

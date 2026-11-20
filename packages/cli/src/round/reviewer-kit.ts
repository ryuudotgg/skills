import { splitlines } from "../hooks/text.ts";
import type { Declaration } from "../reviewers/declaration.ts";
import { timestamp } from "./timestamp.ts";
import type { Author, CheckRun, Commit, PullRequest, Snapshot, StatusContext } from "./types.ts";

export function authorMatcher(declaration: Pick<Declaration, "logins">) {
  const logins = new Set(declaration.logins.map((login) => login.toLowerCase()));
  return (author: Author) => logins.has(author?.login?.toLowerCase() ?? "");
}

export function worst<Level extends string>(
  levels: Level[],
  rank: Record<Level, number>,
): Level | "none" {
  let found: Level | "none" = "none";
  for (const candidate of levels)
    if (found === "none" || rank[candidate] > rank[found]) found = candidate;

  return found;
}

export function triggerTimes(
  snapshot: Pick<Snapshot, "comments">,
  declaration: Pick<Declaration, "trigger">,
  message: "cannot parse PR checks" | "cannot parse PR review",
): number[] {
  return snapshot.comments
    .filter((comment) => (comment.body ?? "").trim() === declaration.trigger)
    .map((comment) => timestamp(comment.createdAt, message));
}

export function headArrival(head: Commit): number {
  const suites = head.checkSuites.nodes.map((suite) =>
    timestamp(suite.createdAt, "cannot parse PR checks"),
  );

  return suites.length
    ? Math.min(...suites)
    : timestamp(head.committedDate, "cannot parse PR checks");
}

export function appSuites(head: Commit, seen: (author: Author) => boolean) {
  return head.checkSuites.nodes.filter((suite) => seen({ login: `${suite.app?.slug ?? ""}[bot]` }));
}

export function headContexts(
  snapshot: Snapshot,
  names: readonly string[],
  seen: (author: Author) => boolean,
): (CheckRun | StatusContext)[] | null {
  const head = snapshot.pr.commits.nodes.at(-1)!.commit;
  const page = head.statusCheckRollup?.contexts;
  if (!page?.pageInfo?.hasNextPage) return page?.nodes ?? [];

  let suite: { createdAt: string } | undefined;
  for (const candidate of appSuites(head, seen))
    if (
      !suite ||
      timestamp(candidate.createdAt, "cannot parse PR checks") >
        timestamp(suite.createdAt, "cannot parse PR checks")
    )
      suite = candidate;

  // Fetched runs carry no id, so a copy of a page run looks like a newer run with the same fields; keeping both can only lengthen a wait.
  const supplement: (CheckRun | StatusContext)[] = [];
  for (const name of names) {
    const runs = snapshot.headChecks[name];
    if (!runs) return null;

    for (const run of runs)
      supplement.push(
        run.__typename === "StatusContext" || run.checkSuite || !suite
          ? run
          : { ...run, checkSuite: { createdAt: suite.createdAt } },
      );
  }

  return [...page.nodes, ...supplement];
}

export function headPush(head: Commit): number {
  // A reviewer's facts reject a malformed commit date even when check suites set the arrival.
  timestamp(head.committedDate, "cannot parse PR review");
  return headArrival(head);
}

export function openThreads<Level extends string>(
  threads: PullRequest["reviewThreads"],
  seen: (author: Author) => boolean,
  level: (line: string) => Level,
) {
  const levels: (Level | "critical")[] = [];
  const unanswered: (Level | "critical")[] = [];
  for (const thread of threads.nodes) {
    const starter = thread.comments.nodes;
    if (!starter[0] || !seen(starter[0].author)) continue;
    if (typeof thread.isResolved !== "boolean") throw new Error("cannot parse PR review");
    if (thread.isResolved) continue;

    const found = level(splitlines(starter[0].body || "").find((line) => line.trim()) ?? "");
    levels.push(found);
    const latest = thread.latest?.nodes ?? starter;
    if (latest.length && seen(latest.at(-1)!.author)) unanswered.push(found);
  }

  if (threads.nodes.length >= 100) {
    levels.push("critical");
    unanswered.push("critical");
  }

  return { levels, unanswered };
}

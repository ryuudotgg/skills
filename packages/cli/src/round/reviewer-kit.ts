import { splitlines } from "../hooks/text.ts";
import type { Declaration } from "../reviewers/declaration.ts";
import { timestamp } from "./timestamp.ts";
import type { Author, Commit, PullRequest } from "./types.ts";

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

export function headArrival(head: Commit): number {
  const suites = head.checkSuites.nodes.map((suite) =>
    timestamp(suite.createdAt, "cannot parse PR checks"),
  );

  return suites.length
    ? Math.min(...suites)
    : timestamp(head.committedDate, "cannot parse PR checks");
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

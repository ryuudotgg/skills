import type { Declaration } from "../reviewers/declaration.ts";
import type { CheckRun, Presence, Snapshot, StatusContext } from "./types.ts";

export const limits = { window: 60, cap: 1200 } as const;

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("cannot parse PR checks");
  return parsed;
}

export function presence(
  snapshot: Snapshot,
  declaration: Pick<Declaration, "check" | "trigger" | "logins">,
  now: string,
): Presence {
  const { pr } = snapshot;
  const commits = pr.commits.nodes.map((node) => node.commit);
  const head = commits.at(-1);
  if (!head) throw new Error("cannot parse PR checks");

  const nowTime = timestamp(now);
  const checkName = declaration.check.toLowerCase();
  const logins = new Set(declaration.logins.map((login) => login.toLowerCase()));
  const authorSeen = (author: { login: string } | null) =>
    logins.has(author?.login?.toLowerCase() ?? "");

  const contexts = commits.map((commit) => commit.statusCheckRollup?.contexts.nodes ?? []);
  const matches = (context: CheckRun | StatusContext) =>
    context.__typename === "StatusContext"
      ? context.state !== "EXPECTED" && context.context.toLowerCase().includes(checkName)
      : context.name.toLowerCase().includes(checkName);

  const suites = head.checkSuites.nodes.map((suite) => timestamp(suite.createdAt));
  const push = suites.length ? Math.min(...suites) : timestamp(head.committedDate);
  const events: [number, Presence["event"]][] = [[timestamp(pr.createdAt), "open"]];
  if (pr.timelineItems.nodes.length)
    events.push([
      Math.max(...pr.timelineItems.nodes.map((item) => timestamp(item.createdAt))),
      "ready",
    ]);

  events.push([push, "push"]);
  const triggers = pr.comments.nodes
    .filter((comment) => (comment.body ?? "").trim() === declaration.trigger)
    .map((comment) => timestamp(comment.createdAt));

  if (triggers.length) events.push([Math.max(...triggers), "trigger"]);

  let [since, event] = events[0]!;
  for (const candidate of events) if (candidate[0] >= since) [since, event] = candidate;

  const elapsed = Math.max(0, Math.trunc((nowTime - since) / 1000));
  const fullPages =
    pr.userContentEdits.nodes.length >= 20 ||
    [pr.comments.nodes, pr.reviews.nodes, pr.reviewThreads.nodes, commits, ...contexts].some(
      (page) => page.length >= 100,
    );

  const seen =
    contexts.some((page) => page.some(matches)) ||
    pr.userContentEdits.nodes.some((edit) => authorSeen(edit.editor)) ||
    [...pr.comments.nodes, ...pr.reviews.nodes].some((item) => authorSeen(item.author)) ||
    pr.reviewThreads.nodes.some(
      (thread) => thread.comments.nodes[0] && authorSeen(thread.comments.nodes[0].author),
    ) ||
    fullPages;

  const start = (context: CheckRun | StatusContext) => {
    if (context.__typename === "StatusContext") return timestamp(context.createdAt);
    if (context.startedAt) return timestamp(context.startedAt);

    return context.checkSuite?.createdAt
      ? Math.max(timestamp(context.checkSuite.createdAt), since)
      : since;
  };

  let newest: CheckRun | StatusContext | undefined;
  for (const context of contexts.at(-1)!.filter(matches))
    if (!newest || start(context) >= start(newest)) newest = context;

  let check: Presence["check"] = "missing";
  let age: number | null = null;
  if (newest) {
    const time =
      newest.__typename === "CheckRun" && newest.status === "COMPLETED" && newest.completedAt
        ? timestamp(newest.completedAt)
        : start(newest);

    check = (
      newest.__typename === "StatusContext"
        ? newest.state === "PENDING"
        : newest.status !== "COMPLETED"
    )
      ? "pending"
      : "completed";

    if (check === "completed" && event === "trigger" && time < since) check = "missing";
    else age = Math.max(0, Math.trunc((nowTime - time) / 1000));
  }

  const gate =
    check === "pending"
      ? age! < limits.cap
        ? "pending"
        : "timeout"
      : check === "missing" && elapsed < limits.window
        ? "appear"
        : check === "missing" && !seen
          ? "absent"
          : check === "missing" && event === "trigger"
            ? "no-review"
            : "decide";

  return { check, seen, event, elapsed, age, gate };
}

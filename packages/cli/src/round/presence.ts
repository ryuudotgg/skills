import { authorMatcher, headArrival } from "./reviewer-kit.ts";
import { timestamp } from "./timestamp.ts";
import type { Declaration } from "../reviewers/declaration.ts";
import type { CheckRun, Presence, Snapshot, StatusContext } from "./types.ts";

export const limits = { window: 60, start: 180, cap: 1200 } as const;
export function presence(
  snapshot: Snapshot,
  declaration: Pick<Declaration, "check" | "trigger" | "logins">,
  now: string,
): Presence {
  const { pr } = snapshot;
  const commits = pr.commits.nodes.map((node) => node.commit);
  const head = commits.at(-1);
  if (!head) throw new Error("cannot parse PR checks");

  const nowTime = timestamp(now, "cannot parse PR checks");
  const checkName = declaration.check.toLowerCase();
  const authorSeen = authorMatcher(declaration);

  const contexts = commits.map((commit) => commit.statusCheckRollup?.contexts.nodes ?? []);
  const matches = (context: CheckRun | StatusContext) =>
    context.__typename === "StatusContext"
      ? context.state !== "EXPECTED" && context.context.toLowerCase().includes(checkName)
      : context.name.toLowerCase().includes(checkName);

  const appSuites = head.checkSuites.nodes.filter((suite) =>
    authorSeen({ login: `${suite.app?.slug ?? ""}[bot]` }),
  );

  const installed = appSuites.length > 0;

  const push = headArrival(head);
  const events: [number, Presence["event"]][] = [
    [timestamp(pr.createdAt, "cannot parse PR checks"), "open"],
  ];

  if (pr.timelineItems.nodes.length)
    events.push([
      Math.max(
        ...pr.timelineItems.nodes.map((item) =>
          timestamp(item.createdAt, "cannot parse PR checks"),
        ),
      ),
      "ready",
    ]);

  events.push([push, "push"]);
  const triggers = snapshot.comments
    .filter((comment) => (comment.body ?? "").trim() === declaration.trigger)
    .map((comment) => timestamp(comment.createdAt, "cannot parse PR checks"));

  if (triggers.length) events.push([Math.max(...triggers), "trigger"]);

  let [since, event] = events[0]!;
  for (const candidate of events) if (candidate[0] >= since) [since, event] = candidate;

  const elapsed = Math.max(0, Math.trunc((nowTime - since) / 1000));
  const arrival = Math.max(...events.filter(([, kind]) => kind !== "push").map(([time]) => time));
  const waited = Math.max(0, Math.trunc((nowTime - arrival) / 1000));
  const fullPages =
    pr.userContentEdits.nodes.length >= 20 ||
    [pr.comments.nodes, pr.reviews.nodes, pr.reviewThreads.nodes, commits, ...contexts].some(
      (page) => page.length >= 100,
    );

  const active =
    contexts.some((page) => page.some(matches)) ||
    pr.userContentEdits.nodes.some((edit) => authorSeen(edit.editor)) ||
    [...pr.comments.nodes, ...pr.reviews.nodes].some((item) => authorSeen(item.author)) ||
    pr.reviewThreads.nodes.some(
      (thread) => thread.comments.nodes[0] && authorSeen(thread.comments.nodes[0].author),
    );

  const seen = active || fullPages;

  const start = (context: CheckRun | StatusContext) => {
    if (context.__typename === "StatusContext")
      return timestamp(context.createdAt, "cannot parse PR checks");

    if (context.startedAt) return timestamp(context.startedAt, "cannot parse PR checks");

    return context.checkSuite?.createdAt
      ? Math.max(timestamp(context.checkSuite.createdAt, "cannot parse PR checks"), since)
      : since;
  };

  let appSuite: { createdAt: string } | undefined;
  for (const suite of appSuites)
    if (
      !appSuite ||
      timestamp(suite.createdAt, "cannot parse PR checks") >
        timestamp(appSuite.createdAt, "cannot parse PR checks")
    )
      appSuite = suite;

  const supplement = (snapshot.headChecks[declaration.check] ?? []).map((run) =>
    run.checkSuite || !appSuite ? run : { ...run, checkSuite: { createdAt: appSuite.createdAt } },
  );

  const headContexts = head.statusCheckRollup?.contexts.pageInfo?.hasNextPage
    ? [...contexts.at(-1)!, ...supplement]
    : contexts.at(-1)!;

  let newest: CheckRun | StatusContext | undefined;
  for (const context of headContexts.filter(matches))
    if (!newest || start(context) >= start(newest)) newest = context;

  let check: Presence["check"] = "missing";
  let age: number | null = null;
  if (newest) {
    const time =
      newest.__typename === "CheckRun" && newest.status === "COMPLETED" && newest.completedAt
        ? timestamp(newest.completedAt, "cannot parse PR checks")
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

  const starting = installed && (!active || event === "trigger") && waited < limits.start;
  const gate =
    check === "pending"
      ? age! < limits.cap
        ? "pending"
        : "timeout"
      : check === "missing" && (elapsed < limits.window || starting)
        ? "appear"
        : check === "missing" && !seen && !installed
          ? "absent"
          : check === "missing" && event === "trigger"
            ? "no-review"
            : check === "missing" && !seen
              ? "no-start"
              : "decide";

  return { check, seen, event, elapsed, age, gate };
}

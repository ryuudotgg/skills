import {
  authorMatcher,
  headPush,
  openThreads,
  worst,
} from "../../packages/cli/src/round/reviewer-kit.ts";
import { timestamp } from "../../packages/cli/src/round/timestamp.ts";
import type {
  CheckRun,
  Fixes,
  ReviewerInput,
  StatusContext,
  Verdict,
} from "../../packages/cli/src/round/types.ts";

type Level = "critical" | "high" | "medium" | "low";
export type Facts = {
  reviewed: boolean;
  reviews: number;
  worst: Level | "none";
  unanswered: Level | "none";
  triggered: boolean;
  approval: "approved" | "not-approved" | "pending" | "none";
  fixesFrom: null;
};

export const headChecks = ["Macroscope - Approvability Check", "Macroscope - Correctness Check"];
const approvalName = headChecks[0]!.toLowerCase();
const severity = /^[^\p{L}\p{N}_*]*\*\*(critical|high|medium|low)\*\*/iu;
const rank = { low: 0, medium: 1, high: 2, critical: 3 };

function level(line: string): Level {
  return (severity.exec(line)?.[1]?.toLowerCase() as Level | undefined) ?? "critical";
}

function newest(contexts: (CheckRun | StatusContext)[], name: string): CheckRun | null {
  let found: CheckRun | null = null;
  let latest = -Infinity;
  for (const item of contexts) {
    if (item.__typename !== "CheckRun" || !(item.name || "").toLowerCase().includes(name)) continue;

    const start = item.startedAt || item.checkSuite?.createdAt;
    const time = start ? timestamp(start, "cannot parse PR review") : -Infinity;
    if (found === null || time >= latest) {
      latest = time;
      found = item;
    }
  }

  return found;
}

function readFacts(input: ReviewerInput): Facts {
  const { pr, comments, headChecks: fetched } = input.snapshot;
  const { declaration } = input;
  const commits = pr.commits.nodes.map((node) => node.commit);
  const head = commits.at(-1)!;
  const push = headPush(head);

  const now = timestamp(input.now, "cannot parse PR review");
  const triggered = comments.some(
    (item) =>
      (item.body || "").trim() === declaration.trigger &&
      timestamp(item.createdAt, "cannot parse PR review") > push,
  );

  const source = head.statusCheckRollup?.contexts;
  const truncated = source?.pageInfo?.hasNextPage === true;
  const supplement = truncated
    ? headChecks.flatMap((name) => {
        const runs = fetched[name];
        if (!runs) throw new Error("cannot read head checks");
        return runs;
      })
    : [];

  const headContexts = [...(source?.nodes ?? []), ...supplement];

  const reviewCommits = new Set<string>();
  for (const commit of commits) {
    const latest = newest(
      commit === head ? headContexts : (commit.statusCheckRollup?.contexts.nodes ?? []),
      declaration.check.toLowerCase(),
    );

    if (latest?.status === "COMPLETED" && ["SUCCESS", "NEUTRAL"].includes(latest.conclusion ?? ""))
      reviewCommits.add(commit.oid);
  }

  const threads = openThreads(pr.reviewThreads, authorMatcher(declaration), level);
  const latest = newest(headContexts, approvalName);

  let approval: Facts["approval"] = "none";
  if (latest?.status === "COMPLETED")
    approval =
      latest.conclusion === "SUCCESS"
        ? "approved"
        : ["SKIPPED", "CANCELLED"].includes(latest.conclusion ?? "")
          ? "none"
          : "not-approved";
  else if (latest !== null) {
    const start = latest.startedAt || latest.checkSuite?.createdAt;
    if (
      start !== undefined &&
      start !== null &&
      (now - timestamp(start, "cannot parse PR review")) / 1000 < input.limits.cap
    )
      approval = "pending";
  }

  return {
    reviewed: reviewCommits.has(head.oid),
    reviews:
      (pr.commits.totalCount ?? commits.length) > commits.length
        ? Math.max(reviewCommits.size, 100)
        : reviewCommits.size,
    worst: worst(threads.levels, rank),
    unanswered: worst(threads.unanswered, rank),
    triggered,
    approval,
    fixesFrom: null,
  };
}

export function facts(input: ReviewerInput): Facts {
  try {
    return readFacts(input);
  } catch {
    throw new Error("cannot parse PR review");
  }
}

export function decide(facts: Facts, _fixes: Fixes | null, input: ReviewerInput): Verdict {
  const { presence, settings, critical } = input;

  let floor = settings.threshold as Level;
  if (critical && rank[settings["critical-threshold"] as Level] < rank[floor])
    floor = settings["critical-threshold"] as Level;

  const budgetLeft = BigInt(facts.reviews) <= BigInt(settings.rereviews!);
  const atFloor = (value: Facts["worst"]) => value !== "none" && rank[value] >= rank[floor];
  const findings = (): Verdict =>
    input.outcome === "dismissed"
      ? "handback all-dismissed"
      : budgetLeft
        ? "triage findings"
        : "handback round-cap";

  const unavailable = (reason: string): Verdict =>
    atFloor(facts.unanswered) ? findings() : `unavailable ${reason}`;

  if (presence.gate === "pending") return "wait check-pending";
  if (presence.gate === "appear") return "wait check-appear";
  if (presence.gate === "absent") return "absent";
  if (presence.gate === "timeout" || presence.gate === "no-review" || presence.gate === "no-start")
    return unavailable(presence.gate);

  if (atFloor(facts.unanswered)) return findings();
  if (!facts.reviewed)
    return facts.triggered
      ? unavailable("no-review")
      : budgetLeft
        ? "rereview paused"
        : unavailable("paused");

  if (atFloor(facts.worst)) return findings();
  if (facts.approval === "pending") return "wait approval-pending";
  if (facts.approval === "approved") return "done approved";
  if (facts.approval === "none") return "done clean";
  if (critical) return "handback not-approved";

  return "done clean not-approved";
}

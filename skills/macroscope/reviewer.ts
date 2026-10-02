import { pyStrip, splitlines } from "../../src/hooks/python-text.ts";
import type {
  CheckRun,
  Fixes,
  ReviewerInput,
  StatusContext,
  Verdict,
} from "../../src/round/types.ts";

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

export const headChecks = ["Macroscope - Approvability Check"];
const approvalName = headChecks[0]!.toLowerCase();
const severity = /^[^\p{L}\p{N}_*]*\*\*(critical|high|medium|low)\*\*/iu;
const rank = { low: 0, medium: 1, high: 2, critical: 3 };

function timestamp(value: string): number {
  const parts =
    /^(\d{4})-?(\d{2})-?(\d{2})(?:.(\d{2}):?(\d{2})(?::?(\d{2})(?:[.,](\d+))?)?(Z|[+-]\d{2}:?\d{2})?)?$/u.exec(
      value,
    );

  if (!parts) throw new Error("cannot parse PR review");

  const date = new Date(0);
  date.setUTCFullYear(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));

  if (
    Number(parts[1]) < 1 ||
    date.getUTCMonth() !== Number(parts[2]) - 1 ||
    date.getUTCDate() !== Number(parts[3]) ||
    Number(parts[4] ?? 0) > 23 ||
    Number(parts[5] ?? 0) > 59 ||
    Number(parts[6] ?? 0) > 59
  )
    throw new Error("cannot parse PR review");

  const parsed = Date.parse(
    `${parts[1]}-${parts[2]}-${parts[3]}T${parts[4] ?? "00"}:${parts[5] ?? "00"}:${parts[6] ?? "00"}${parts[8] || "Z"}`,
  );

  if (!Number.isFinite(parsed)) throw new Error("cannot parse PR review");

  return parsed + Number(`0.${(parts[7] ?? "0").slice(0, 6)}`) * 1000;
}

function level(body: string): Level {
  const first = splitlines(body).find((line) => pyStrip(line)) ?? "";
  return (severity.exec(first)?.[1]?.toLowerCase() as Level | undefined) ?? "critical";
}

function worst(levels: Level[]): Level | "none" {
  let found: Level | "none" = "none";
  for (const candidate of levels)
    if (found === "none" || rank[candidate] > rank[found]) found = candidate;

  return found;
}

function newest(contexts: (CheckRun | StatusContext)[], name: string): CheckRun | null {
  let found: CheckRun | null = null;
  let latest = -Infinity;
  for (const item of contexts) {
    if (item.__typename !== "CheckRun" || !(item.name || "").toLowerCase().includes(name)) continue;

    const start = item.startedAt || item.checkSuite?.createdAt;
    const time = start ? timestamp(start) : -Infinity;
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
  const logins = new Set(declaration.logins.map((login) => login.toLowerCase()));
  const bot = (entry: { author: { login: string } | null }) =>
    logins.has(entry.author?.login?.toLowerCase() ?? "");

  const commits = pr.commits.nodes.map((node) => node.commit);
  const head = commits.at(-1)!;
  const suites = (head.checkSuites?.nodes ?? []).map((suite) => timestamp(suite.createdAt));
  const fallback = timestamp(head.committedDate);
  const push = suites.length ? Math.min(...suites) : fallback;

  const now = timestamp(input.now);
  const triggered = comments.some(
    (item) => pyStrip(item.body || "") === declaration.trigger && timestamp(item.createdAt) > push,
  );

  const reviewCommits = new Set<string>();
  for (const commit of commits) {
    const latest = newest(
      commit.statusCheckRollup?.contexts.nodes ?? [],
      declaration.check.toLowerCase(),
    );

    if (latest?.status === "COMPLETED" && ["SUCCESS", "NEUTRAL"].includes(latest.conclusion ?? ""))
      reviewCommits.add(commit.oid);
  }

  const levels: Level[] = [];
  const unanswered: Level[] = [];
  for (const thread of pr.reviewThreads.nodes) {
    const starter = thread.comments.nodes;
    if (!starter[0] || !bot(starter[0])) continue;
    if (typeof thread.isResolved !== "boolean") throw new Error("cannot parse PR review");
    if (thread.isResolved) continue;

    const found = level(starter[0].body || "");
    levels.push(found);
    const latest = thread.latest?.nodes ?? starter;
    if (latest.length && bot(latest.at(-1)!)) unanswered.push(found);
  }

  if (pr.reviewThreads.nodes.length >= 100) {
    levels.push("critical");
    unanswered.push("critical");
  }

  const source = head.statusCheckRollup?.contexts;
  const truncated = source?.pageInfo?.hasNextPage === true;
  const supplement = fetched[headChecks[0]!];
  if (truncated && !supplement) throw new Error("cannot read head checks");

  const contexts = [...(source?.nodes ?? []), ...(truncated ? supplement! : [])];

  const latest = newest(contexts, approvalName);

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
    if (start !== undefined && start !== null && (now - timestamp(start)) / 1000 < input.limits.cap)
      approval = "pending";
  }

  return {
    reviewed: reviewCommits.has(head.oid),
    reviews:
      (pr.commits.totalCount ?? commits.length) > commits.length
        ? Math.max(reviewCommits.size, 100)
        : reviewCommits.size,
    worst: worst(levels),
    unanswered: worst(unanswered),
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
  const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
  const levels = ["critical", "high", "medium", "low"];
  if (
    !/^\d+$/.test(settings.rereviews ?? "") ||
    !levels.includes(settings.threshold!) ||
    !levels.includes(settings["critical-threshold"]!) ||
    ![facts.reviewed, facts.triggered, presence.seen, critical].every(
      (value) => typeof value === "boolean",
    ) ||
    !integer(facts.reviews) ||
    ![...levels, "none"].includes(facts.worst) ||
    ![...levels, "none"].includes(facts.unanswered) ||
    !["approved", "not-approved", "pending", "none"].includes(facts.approval) ||
    facts.fixesFrom !== null ||
    ![null, "fixed", "dismissed"].includes(input.outcome) ||
    !["pending", "completed", "missing"].includes(presence.check) ||
    !["open", "ready", "push", "trigger"].includes(presence.event) ||
    !integer(presence.elapsed) ||
    (presence.age !== null && !integer(presence.age)) ||
    !["pending", "appear", "absent", "timeout", "no-review", "no-start", "decide"].includes(presence.gate)
  )
    throw new Error("cannot decide review state");

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

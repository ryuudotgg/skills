import { PY_SPACE, pyLstrip, pyStrip, splitlines } from "../../src/hooks/python-text.ts";
import type { Comment, Fixes, ReviewerInput, Verdict } from "../../src/round/types.ts";

type Level = "critical" | "major" | "minor" | "trivial";
export type Facts = {
  approved: boolean;
  reviewed: boolean;
  limited: boolean;
  retry: number | null;
  reviews: number;
  worst: Level | "none";
  unanswered: Level | "none";
  triggered: boolean;
  skipped: "disabled" | "ineligible" | null;
  fixesFrom: null;
};

const rank = { trivial: 0, minor: 1, major: 2, critical: 3 };
const severity = new RegExp(`(🔴|🟠|🟡|🔵|⚪)[${PY_SPACE}]*(Critical|Major|Minor|Trivial)`, "i");
const statusOutcomes = [
  ["review completed", "completed"],
  ["review approved", "completed"],
  ["review skipped: automatic reviews are disabled", "disabled"],
  ["review skipped: bot user not eligible for review", "ineligible"],
] as const;

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

function level(text: string): Level {
  return (severity.exec(text)?.[2]?.toLowerCase() as Level | undefined) ?? "critical";
}

function worst(levels: Level[]): Level | "none" {
  let found: Level | "none" = "none";
  for (const candidate of levels)
    if (found === "none" || rank[candidate] > rank[found]) found = candidate;

  return found;
}

function outsideLevels(body: string, outside: string): Level[] {
  const lines = splitlines(body);
  const levels: Level[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.includes(outside)) continue;

    const block = [line];
    for (const next of lines.slice(index + 1)) {
      if (!pyLstrip(next).startsWith(">")) break;
      block.push(next);
    }

    const heading = /\(([0-9]+)\)/.exec(line);
    const chunks = block.join("\n").split(new RegExp(`<!--[${PY_SPACE}]*cr-comment:`));
    levels.push(...chunks.slice(0, -1).map(level));
    if (heading === null || chunks.length - 1 !== Number(heading[1])) levels.push("critical");
  }

  return levels;
}

function noticeSeconds(body: string): number | null {
  const match = new RegExp(
    `Next included review available in[${PY_SPACE}]*([^\\n]+)|Please wait[${PY_SPACE}]*\\*\\*(.*?)\\*\\*`,
    "is",
  ).exec(body);

  if (!match) return null;

  const units = { second: 1, minute: 60, hour: 3600 };
  const pairs = [
    ...(match[1] ?? match[2]!).matchAll(
      new RegExp(`([0-9]+)[${PY_SPACE}]*(seconds?|minutes?|hours?)`, "gi"),
    ),
  ];

  if (!pairs.length) return null;

  return pairs.reduce(
    (total, pair) =>
      total +
      Number(pair[1]) * units[pair[2]!.toLowerCase().replace(/s+$/, "") as keyof typeof units],
    0,
  );
}

function readFacts(input: ReviewerInput): Facts {
  const { pr } = input.snapshot;
  const { declaration } = input;
  const outside = declaration.outsideDiff;
  if (!outside) throw new Error("coderabbit is not a declared reviewer");

  const logins = new Set(declaration.logins.map((login) => login.toLowerCase()));
  const bot = (entry: { author: { login: string } | null }) =>
    logins.has(entry.author?.login?.toLowerCase() ?? "");

  const commits = pr.commits.nodes.map((node) => node.commit);
  const head = commits.at(-1)!;
  const suites = (head.checkSuites?.nodes ?? []).map((suite) => timestamp(suite.createdAt));
  const fallback = timestamp(head.committedDate);
  const push = suites.length ? Math.min(...suites) : fallback;

  const comments = pr.comments.nodes;
  const triggers = comments
    .filter((item) => pyStrip(item.body || "") === declaration.trigger)
    .map((item) => timestamp(item.createdAt));

  const now = timestamp(input.now);
  const reviewCommits = new Set<string>();

  let headOutcome: "completed" | "disabled" | "ineligible" | null = null;
  let checkLimited = false;
  for (const commit of commits) {
    let lastCheck = null;
    for (const item of commit.statusCheckRollup?.contexts.nodes ?? []) {
      const name = item.__typename === "StatusContext" ? item.context : item.name;
      if (name?.toLowerCase().includes(declaration.check.toLowerCase())) lastCheck = item;
    }

    if (!lastCheck) continue;

    const description = pyStrip(
      (lastCheck.__typename === "StatusContext" ? lastCheck.description : lastCheck.title) || "",
    ).toLowerCase();

    const outcome = statusOutcomes.find(([prefix]) => description.startsWith(prefix))?.[1] ?? null;
    if (outcome === "completed") reviewCommits.add(commit.oid);
    if (commit.oid === head.oid) {
      headOutcome = outcome;
      checkLimited = description.includes("rate limited");
    }
  }

  let reviewed = headOutcome === "completed";
  let approved = false;
  const levels: Level[] = [];
  const unanswered: Level[] = [];

  for (const review of pr.reviews.nodes) {
    if (!bot(review)) continue;

    const oid = review.commit?.oid;
    const counts = review.state === "APPROVED" || Boolean(pyStrip(review.body || ""));
    if (counts && oid) reviewCommits.add(oid);
    if (oid === head.oid && counts) {
      reviewed = true;
      levels.push(...outsideLevels(review.body || "", outside));
      approved = review.state === "APPROVED";
    }
  }

  for (const thread of pr.reviewThreads.nodes) {
    const starter = thread.comments.nodes;
    if (!starter[0] || !bot(starter[0])) continue;
    if (typeof thread.isResolved !== "boolean") throw new Error("cannot parse PR review");
    if (thread.isResolved) continue;

    const first = splitlines(starter[0].body || "").find((line) => pyStrip(line)) ?? "";
    levels.push(level(first));
    const latest = thread.latest?.nodes ?? starter;
    if (latest.length && bot(latest.at(-1)!)) unanswered.push(level(first));
  }

  let notice: Comment | null = null;
  for (const item of comments) {
    if (!bot(item) || !(item.body || "").toLowerCase().includes("rate limited by coderabbit.ai"))
      continue;

    const time = timestamp(item.updatedAt!);
    if (notice === null || time > timestamp(notice.updatedAt!)) notice = item;
  }

  const seconds = notice === null ? null : noticeSeconds(notice.body!);
  const remaining =
    seconds === null ? null : (timestamp(notice!.updatedAt!) + seconds * 1000 - now) / 1000;

  const triggered = triggers.some(
    (time) => time > push && (notice === null || time > timestamp(notice.updatedAt!)),
  );

  const fresh = notice !== null && (remaining !== null || timestamp(notice.updatedAt!) > push);
  const limited = (checkLimited || fresh) && (remaining === null || remaining > 0);

  if (pr.reviewThreads.nodes.length >= 100) {
    levels.push("critical");
    unanswered.push("critical");
  }

  return {
    approved,
    reviewed,
    limited,
    retry: limited && remaining !== null ? Math.ceil(remaining / 60) : null,
    reviews: pr.reviews.nodes.length >= 100 ? pr.reviews.nodes.length : reviewCommits.size,
    worst: worst(levels),
    unanswered: worst(unanswered),
    triggered,
    skipped: headOutcome === "disabled" || headOutcome === "ineligible" ? headOutcome : null,
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
  const { presence, settings, critical, limits } = input;
  const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
  const levels = ["critical", "major", "minor", "trivial"];
  if (
    !/^\d+$/.test(settings.rereviews ?? "") ||
    !levels.includes(settings.threshold!) ||
    !levels.includes(settings["critical-threshold"]!) ||
    ![
      facts.approved,
      facts.reviewed,
      facts.limited,
      facts.triggered,
      presence.seen,
      critical,
    ].every((value) => typeof value === "boolean") ||
    !integer(facts.reviews) ||
    (facts.retry !== null && !integer(facts.retry)) ||
    ![...levels, "none"].includes(facts.worst) ||
    ![...levels, "none"].includes(facts.unanswered) ||
    ![null, "disabled", "ineligible"].includes(facts.skipped) ||
    facts.fixesFrom !== null ||
    ![null, "fixed", "dismissed"].includes(input.outcome) ||
    !["pending", "completed", "missing"].includes(presence.check) ||
    !["open", "ready", "push", "trigger"].includes(presence.event) ||
    !integer(presence.elapsed) ||
    (presence.age !== null && !integer(presence.age)) ||
    !["pending", "appear", "absent", "timeout", "no-review", "decide"].includes(presence.gate)
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
  if (presence.gate === "timeout" || presence.gate === "no-review")
    return unavailable(
      facts.limited
        ? `rate-limited${facts.retry === null ? "" : ` ${facts.retry}`}`
        : presence.gate,
    );

  if (facts.approved) return "done approved";
  if (!facts.reviewed && facts.limited && (facts.retry !== null || presence.elapsed < limits.cap))
    return unavailable(`rate-limited${facts.retry === null ? "" : ` ${facts.retry}`}`);

  if (!facts.reviewed && facts.skipped === "ineligible") return unavailable("skipped");
  if (!facts.reviewed && facts.skipped === "disabled" && !facts.triggered)
    return budgetLeft ? "rereview paused" : unavailable("paused");

  if (!facts.reviewed && facts.triggered) return unavailable("no-review");
  if (!facts.reviewed) return budgetLeft ? "rereview paused" : unavailable("paused");
  if (!atFloor(facts.worst)) return "done clean";

  return findings();
}

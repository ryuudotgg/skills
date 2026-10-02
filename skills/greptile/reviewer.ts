import { timestamp } from "../../src/round/timestamp.ts";
import type { Fixes, ReviewerInput, Verdict } from "../../src/round/types.ts";

export type Facts = {
  score: number | null;
  paid: number;
  running: boolean;
  skipped: boolean;
  fixesFrom: string | null;
  required: number | null;
};

function score(body: string): number | null {
  if (typeof body !== "string") throw new Error("cannot parse PR review");

  const match =
    /greptile_confidence_score:([0-5])/.exec(body) ??
    /confidence score:\s*([0-5])\s*\/\s*5/i.exec(body);

  return match ? Number(match[1]) : null;
}

export function facts(input: ReviewerInput): Facts {
  const { snapshot, declaration } = input;
  const { pr } = snapshot;
  const logins = new Set(declaration.logins.map((login) => login.toLowerCase()));
  const authorSeen = (author: { login: string } | null) =>
    logins.has(author?.login.toLowerCase() ?? "");

  const triggers = snapshot.comments
    .filter((comment) => (comment.body ?? "").trim() === declaration.trigger)
    .map((comment) => timestamp(comment.createdAt, "cannot parse PR review"));

  const since = triggers.length
    ? Math.max(...triggers)
    : timestamp(pr.createdAt, "cannot parse PR review");

  const edits = pr.userContentEdits.nodes
    .filter((edit) => authorSeen(edit.editor))
    .map((edit) => timestamp(edit.editedAt, "cannot parse PR review"));

  const newestEdit = edits.length ? Math.max(...edits) : null;
  const bodyScore = score(pr.body);
  let newestScore: { time: number; value: number } | null =
    newestEdit !== null && newestEdit > since && bodyScore !== null
      ? { time: newestEdit, value: bodyScore }
      : null;

  const bodySha = /Last reviewed commit[^\n]*commit\/([0-9a-fA-F]{40})(?![0-9a-fA-F])/.exec(
    pr.body,
  );

  let reviewed: { time: number; sha: string } | null =
    newestEdit !== null && bodySha ? { time: newestEdit, sha: bodySha[1]! } : null;

  let skipTime: number | null = null;
  const entries = [
    ...pr.comments.nodes.map((entry) => ({ ...entry, time: entry.updatedAt, commit: undefined })),
    ...pr.reviews.nodes.map((entry) => ({ ...entry, time: entry.submittedAt })),
  ];

  for (const entry of entries) {
    if (!authorSeen(entry.author) || !entry.time) continue;

    const time = timestamp(entry.time, "cannot parse PR review");
    if (entry.commit !== undefined && (entry.body ?? "").trim()) {
      if (entry.commit === null) throw new Error("cannot parse PR review");
      if (!reviewed || time > reviewed.time) reviewed = { time, sha: entry.commit.oid };
    }

    if (time <= since) continue;

    const value = score(entry.body!);
    if (value !== null && (!newestScore || time > newestScore.time)) newestScore = { time, value };
    if (/review was skipped/i.test(entry.body!) && (skipTime === null || time > skipTime))
      skipTime = time;
  }

  const now = timestamp(input.now, "cannot parse PR review");

  let running = false;
  let required: number | null = null;
  for (const { commit } of pr.commits.nodes)
    for (const check of commit.statusCheckRollup?.contexts.nodes ?? []) {
      if (
        check.__typename !== "CheckRun" ||
        !check.name.toLowerCase().includes(declaration.check.toLowerCase())
      )
        continue;

      const started = check.startedAt || check.checkSuite?.createdAt;
      if (
        check.status !== "COMPLETED" &&
        (!started || (now - timestamp(started, "cannot parse PR review")) / 1000 < input.limits.cap)
      )
        running = true;

      const stated = /required\s+([0-5])\s*\/\s*5/i.exec(check.title ?? "");
      if (stated) required = Number(stated[1]);
    }

  return {
    score: newestScore?.value ?? null,
    paid: triggers.length,
    running,
    skipped: skipTime !== null && (newestScore === null || skipTime > newestScore.time),
    fixesFrom: reviewed?.sha ?? null,
    required,
  };
}

export function decide(facts: Facts, fixes: Fixes | null, input: ReviewerInput): Verdict {
  const { presence, settings, critical, limits } = input;
  const threshold = Math.max(
    facts.required ?? Number(settings.threshold),
    critical ? Number(settings["critical-threshold"]) : 0,
  );

  const manual = settings.auto === "no";
  if (manual && facts.paid === 0 && !presence.seen) return "absent optional";

  let gate = presence.gate;
  if (manual && gate === "appear" && presence.event !== "trigger")
    gate = presence.seen ? "decide" : "no-review";
  else if (manual && (gate === "absent" || gate === "no-start")) gate = "no-review";

  const small = fixes !== null && fixes.lines < 30 && fixes.added === 0;
  if (gate === "pending") return "wait check-pending";
  if (gate === "appear") return "wait check-appear";
  if (gate === "absent") return "absent";
  if (facts.skipped) return "unavailable skipped";
  if (gate === "timeout" || gate === "no-review" || gate === "no-start")
    return `unavailable ${gate}`;

  if (facts.score === null && facts.running) return "wait check-pending";
  if (
    facts.score === null &&
    presence.check === "completed" &&
    presence.age !== null &&
    presence.age < limits.window
  )
    return "wait no-score";

  if (facts.score === null || facts.fixesFrom === null)
    return facts.score === null ? "handback no-score" : "handback no-reviewed-commit";

  if (fixes === null) return "triage scored";
  if (facts.score >= threshold) return small ? "done threshold" : "done large-fix";
  if (facts.paid >= Number(settings.rereviews) + (manual ? 1 : 0)) return "handback paid-cap";
  if (fixes.commits === 0 && fixes.moved) return "handback rebase-only";
  if (fixes.commits === 0) return "handback all-dismissed";

  return "rereview below-threshold";
}

import { deliveryFrom, readDeliveryConfig } from "../delivery.ts";
import { GhGitHubReader, resolveContext, WatcherQueryError } from "../pr/github.ts";
import { judge, lines, waitForGreen, type Verdict } from "../pr/green.ts";
import type { WatchClock } from "../pr/policy.ts";
import {
  parsePrNumber,
  type GitHubReader,
  type PrNumber,
  type PullRequestFacts,
} from "../pr/types.ts";
import { reviewerDeclarations } from "../pr/watch.ts";
import { runRead } from "../review/read.ts";
import { dependencies as reviewDependencies } from "../review/threads.ts";
import { readDeclarations } from "../reviewers/declaration.ts";
import { dependencies, parseRound, runRound, type RoundOptions } from "./round.ts";
import type { CommandOutput, Dependencies } from "./types.ts";

export const driveUsage =
  "skills round drive <pr> <branch> [critical=true] [<reviewer>=fixed|<reviewer>=dismissed ...] (ROUND_DRIVE_CAP=<seconds>, default 570)";

export type DriveDeps = Dependencies & {
  reader: GitHubReader;
  watch: WatchClock;
  review(pr: string): Promise<CommandOutput>;
  bound?(deadline: number): void;
};

const hardStopGrace = 25;

const exitCodes = { handoff: 0, refused: 1, triage: 3, red: 4, conflict: 5, wait: 6 } as const;
type DriveResult = {
  [Word in keyof typeof exitCodes]: { word: Word; lines: string[] };
}[keyof typeof exitCodes];

function output(result: DriveResult): CommandOutput {
  return {
    code: exitCodes[result.word],
    stdout: `${result.word}\n${result.lines.join("")}`,
    stderr: "",
  };
}

function conflict(facts: PullRequestFacts): string {
  return `#${facts.context.number} conflicts with ${facts.baseRefName} ${facts.mergeable} ${facts.mergeStateStatus}\n`;
}

function failingLines(number: PrNumber, verdict: Verdict): string[] {
  if (verdict.kind !== "red") return [];

  return verdict.faults
    .filter((fault) => fault.kind === "failing" || fault.kind === "blocked")
    .flatMap((fault) => lines(number, { kind: "red", faults: [fault] }))
    .map((line) => `${line}\n`);
}

async function executeDrive(
  options: RoundOptions,
  deps: DriveDeps,
  detail: string[],
): Promise<DriveResult> {
  const cap = deps.env.ROUND_DRIVE_CAP ?? "";
  const deadline = deps.clock() + (/^[1-9]\d*$/.test(cap) ? Number(cap) : 570);
  deps.bound?.(deadline + hardStopGrace);

  const declarations = readDeclarations(deps.root);
  const delivery = deliveryFrom(deps.root, readDeliveryConfig(deps.env));
  const active = declarations.filter(
    (entry) => delivery.mode === "prs" && delivery.active.includes(entry.name),
  );

  const reviewerChecks = declarations.map((entry) => entry.check);
  const context = await resolveContext({
    reader: deps.reader,
    owner: null,
    repo: null,
    pr: parsePrNumber(Number(options.pr)),
  });

  const read = await deps.reader.read(context);
  const initialHead = read.facts.headRefOid;
  const outcomes = options.outcomes.size
    ? [
        `outcomes ${[...options.outcomes].map(([name, outcome]) => `${name}=${outcome}`).join(" ")}\n`,
      ]
    : [];

  const verdict = judge(read, reviewerChecks);
  if (verdict.kind === "merged") return { word: "refused", lines: [`#${options.pr} merged\n`] };
  if (read.facts.state === "CLOSED") return { word: "refused", lines: [`#${options.pr} closed\n`] };
  if (read.facts.isDraft) return { word: "refused", lines: [`#${options.pr} draft\n`] };
  if (verdict.kind === "red" && verdict.faults.some((fault) => fault.kind === "conflicting"))
    return { word: "conflict", lines: [conflict(read.facts), ...outcomes] };

  const triggered = new Set<string>();
  const critical = options.critical ? ["critical=true"] : [];

  let phase: RoundOptions["phase"] = options.outcomes.size ? "decide" : "gate";
  let combined: string;
  for (;;) {
    const args =
      phase === "decide"
        ? [
            "decide",
            options.pr,
            options.branch,
            ...critical,
            ...[...options.outcomes].map(([name, outcome]) => `${name}=${outcome}`),
          ]
        : ["gate", options.pr, "--wait", ...critical];

    const round = await runRound(args, deps, deadline);
    detail.push(round.stdout);

    if (phase === "decide") detail.push(...outcomes);
    if (round.stderr) detail.push(round.stderr);
    if (round.code !== 0) return { word: "refused", lines: detail };

    const roundLines = round.stdout.trimEnd().split("\n");
    combined = roundLines.at(-1)!;
    if (combined === "done" || combined.startsWith("handback ")) break;
    if (phase === "gate" && combined === "triage") {
      const failures = failingLines(
        context.number,
        judge(await deps.reader.read(context), reviewerChecks),
      );

      const review = await deps.review(options.pr);
      return review.code === 0
        ? { word: "triage", lines: [...detail, ...failures, review.stdout] }
        : { word: "refused", lines: [...detail, review.stderr] };
    }

    if (phase === "decide" || combined === "rereview") {
      const requested = active.filter((entry) =>
        roundLines.some((line) => line.startsWith(`${entry.name} rereview`)),
      );

      if (phase === "gate" && !requested.length) return { word: "wait", lines: detail };
      if (requested.some((entry) => triggered.has(entry.name)))
        return { word: "wait", lines: detail };

      for (const entry of requested) {
        triggered.add(entry.name);
        const post = await deps.gh(["pr", "comment", options.pr, "--body", entry.trigger], 30_000);
        if (post.code !== 0) return { word: "refused", lines: [...detail, post.stderr] };
      }
    } else return { word: "wait", lines: detail };

    phase = "gate";
  }

  const budget = deadline - deps.clock() - 30;
  if (budget < 0)
    return {
      word: "wait",
      lines: [...detail, `#${options.pr} green not confirmed before the cap\n`],
    };

  const green = await waitForGreen([context], deps.reader, deps.watch, reviewerChecks, 30, budget);

  const last = green.pass[0]!;
  const greenLines = green.lines.map((line) => `${line}\n`);

  if (last.head !== null && last.head !== initialHead)
    return {
      word: "wait",
      lines: [...detail, `#${options.pr} head moved to ${last.head.slice(0, 7)}\n`],
    };

  switch (last.verdict.kind) {
    case "merged":
      return { word: "refused", lines: [...detail, `#${options.pr} merged\n`] };

    case "red":
      if (last.verdict.faults.some((fault) => fault.kind === "conflicting"))
        return { word: "conflict", lines: [...detail, conflict(last.facts!)] };

      if (last.verdict.faults.some((fault) => fault.kind === "closed"))
        return { word: "refused", lines: [...detail, ...greenLines] };

      return { word: "red", lines: [...detail, ...greenLines] };

    case "waiting":
      return {
        word: "wait",
        lines: [...detail, ...greenLines],
      };

    case "green":
      if (last.facts!.isDraft)
        return { word: "refused", lines: [...detail, `#${options.pr} draft\n`] };

      return {
        word: green.code !== 0 ? "wait" : combined.startsWith("handback ") ? "refused" : "handoff",
        lines: [...detail, ...greenLines],
      };
  }
}

export async function runDrive(args: readonly string[], deps: DriveDeps): Promise<CommandOutput> {
  let options: RoundOptions;
  try {
    options = parseRound(["decide", ...args]);
  } catch {
    return { code: 2, stdout: "", stderr: `usage: ${driveUsage}\n` };
  }

  const detail: string[] = [];
  try {
    return output(await executeDrive(options, deps, detail));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return output({
      word: error instanceof WatcherQueryError && error.failure.retryable ? "wait" : "refused",
      lines: [
        ...detail,
        error instanceof WatcherQueryError
          ? `#${options.pr} unreadable ${message}\n`
          : `${message}\n`,
      ],
    });
  }
}

export function clampTimeout(timeout: number, stop: number, now: number): number {
  return Math.max(1000, Math.min(timeout, (stop - now) * 1000));
}

export function driveDependencies(root: string): DriveDeps {
  const deps = dependencies(root);
  const review = reviewDependencies(root);

  let stop = Infinity;
  const budget = (timeout: number) => clampTimeout(timeout, stop, deps.clock());

  return {
    ...deps,
    gh: (args, timeout) => deps.gh(args, budget(timeout)),
    git: (args, timeout) => deps.git(args, budget(timeout)),
    reader: new GhGitHubReader(reviewerDeclarations(root), undefined, () => budget(60_000)),
    watch: { now: deps.clock, sleep: deps.sleep, observedAt: () => new Date().toISOString() },
    review: (pr) =>
      runRead([pr], {
        ...review,
        gh: (args, timeout, input) =>
          review.gh(args, timeout === undefined ? timeout : budget(timeout), input),
      }),
    bound: (deadline) => {
      stop = deadline;
    },
  };
}

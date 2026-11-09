import { deliveryFrom, readDeliveryConfig } from "../delivery.ts";
import { GhGitHubReader, resolveContext, WatcherQueryError } from "../pr/github.ts";
import { judge, lines, notices, recordPasses, waitForGreen, type Verdict } from "../pr/green.ts";
import type { WatchClock } from "../pr/policy.ts";
import {
  parsePrNumber,
  type BaseReader,
  type GitHubReader,
  type PrContext,
  type PrNumber,
  type PrRead,
  type PullRequestFacts,
} from "../pr/types.ts";
import { reviewerDeclarations } from "../pr/watch.ts";
import { runRead } from "../review/read.ts";
import { dependencies as reviewDependencies } from "../review/threads.ts";
import { readDeclarations } from "../reviewers/declaration.ts";
import { headArrival } from "./presence.ts";
import { dependencies, parseRound, runRound, type RoundOptions } from "./round.ts";
import { readPullRequest } from "./snapshot.ts";
import { timestamp } from "./timestamp.ts";
import type { Commit, CommandOutput, Dependencies, PullRequest, ReadRunner } from "./types.ts";

export const driveUsage =
  "skills round drive <pr> <branch> [critical=true] [<reviewer>=fixed|<reviewer>=dismissed ...] (ROUND_DRIVE_CAP=<seconds>, default 570)";

export type DriveDeps = Dependencies & {
  reader: GitHubReader & BaseReader;
  watch: WatchClock;
  review(pr: string): Promise<CommandOutput>;
  bound?(deadline: number): void;
};

const hardStopGrace = 25;
const pollSeconds = 30;

const exitCodes = { handoff: 0, refused: 1, triage: 3, red: 4, conflict: 5, wait: 6 } as const;
type DriveResult = {
  [Word in keyof typeof exitCodes]: { word: Word; lines: string[] };
}[keyof typeof exitCodes];

type Trace = { detail: string[]; facts: PullRequestFacts | null };

function beforeLastLine(text: string, insert: string): string {
  const cut = text.lastIndexOf("\n", text.length - 2) + 1;
  return text.trim() ? `${text.slice(0, cut)}${insert}${text.slice(cut)}` : text;
}

function output(result: DriveResult, trace: Trace): CommandOutput {
  const rounds = trace.detail.join("");
  const info = notices(trace.facts)
    .map((line) => `${line}\n`)
    .join("");

  const own = result.lines.join("");
  return {
    code: exitCodes[result.word],
    stdout: `${result.word}\n${own ? `${rounds}${info}${own}` : beforeLastLine(rounds, info)}`,
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

async function firstRead(deps: DriveDeps, context: PrContext, deadline: number): Promise<PrRead> {
  for (;;) {
    try {
      return await deps.reader.read(context);
    } catch (error) {
      const retryable = error instanceof WatcherQueryError && error.failure.retryable;
      if (!retryable || deps.clock() + pollSeconds > deadline) throw error;
    }

    await deps.sleep(pollSeconds);
  }
}

async function executeDrive(
  options: RoundOptions,
  deps: DriveDeps,
  trace: Trace,
): Promise<DriveResult> {
  const { detail } = trace;
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

  const read = await firstRead(deps, context, deadline);
  trace.facts = read.facts;
  const initialHead = read.facts.headRefOid;
  const outcomes = options.outcomes.size
    ? [
        `outcomes ${[...options.outcomes].map(([name, outcome]) => `${name}=${outcome}`).join(" ")}\n`,
      ]
    : [];

  const verdict = judge(read, reviewerChecks);
  await recordPasses(
    deps.cwd,
    deps.env,
  )([{ number: context.number, head: initialHead, verdict, facts: read.facts }]);

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
    if (round.code !== 0) return { word: "refused", lines: [] };

    const roundLines = round.stdout.trimEnd().split("\n");
    combined = roundLines.at(-1)!;
    if (combined === "done" || combined.startsWith("handback ")) break;
    if (phase === "gate" && combined === "triage") {
      const latest = await deps.reader.read(context);
      trace.facts = latest.facts;
      const failures = failingLines(context.number, judge(latest, reviewerChecks));

      const review = await deps.review(options.pr);
      return review.code === 0
        ? { word: "triage", lines: [...failures, review.stdout] }
        : { word: "refused", lines: [review.stderr] };
    }

    if (phase === "decide" || combined === "rereview") {
      const requested = active.filter((entry) =>
        roundLines.some((line) => line.startsWith(`${entry.name} rereview`)),
      );

      if (phase === "gate" && !requested.length) return { word: "wait", lines: [] };
      if (requested.some((entry) => triggered.has(entry.name))) return { word: "wait", lines: [] };

      for (const entry of requested) {
        triggered.add(entry.name);
        const post = await deps.gh(["pr", "comment", options.pr, "--body", entry.trigger], 30_000);
        if (post.code !== 0) return { word: "refused", lines: [post.stderr] };
      }
    } else return { word: "wait", lines: [] };

    phase = "gate";
  }

  const budget = deadline - deps.clock() - pollSeconds;
  if (budget < 0)
    return {
      word: "wait",
      lines: [`#${options.pr} green not confirmed before the cap\n`],
    };

  const record = recordPasses(deps.cwd, deps.env);
  const green = await waitForGreen(
    [context],
    deps.reader,
    deps.watch,
    reviewerChecks,
    pollSeconds,
    budget,
    () => {},
    async (pass) => {
      trace.facts = pass[0]?.facts ?? trace.facts;
      await record(pass);
    },
  );

  const last = green.pass[0]!;
  const greenLines = green.lines.map((line) => `${line}\n`);

  if (last.head !== null && last.head !== initialHead)
    return {
      word: "wait",
      lines: [`#${options.pr} head moved to ${last.head.slice(0, 7)}\n`],
    };

  switch (last.verdict.kind) {
    case "merged":
      return { word: "refused", lines: [`#${options.pr} merged\n`] };

    case "red":
      if (last.verdict.faults.some((fault) => fault.kind === "conflicting"))
        return { word: "conflict", lines: [conflict(last.facts!)] };

      if (last.verdict.faults.some((fault) => fault.kind === "closed"))
        return { word: "refused", lines: greenLines };

      return { word: "red", lines: greenLines };

    case "waiting":
      return { word: "wait", lines: greenLines };

    case "green":
      if (last.facts!.isDraft) return { word: "refused", lines: [`#${options.pr} draft\n`] };
      if (green.code !== 0) return { word: "wait", lines: greenLines };
      if (combined.startsWith("handback ")) return { word: "refused", lines: greenLines };

      const drift = await baseDrift(options.pr, last.facts!, deps.reader);
      const held = await humanHold(
        options.pr,
        last.facts!,
        declarations.flatMap((entry) => entry.logins),
        deps.gh,
      );

      if (held === null) return { word: "handoff", lines: [...drift, ...greenLines] };
      if (held.word === "wait") return { word: "wait", lines: [`#${options.pr} ${held.line}\n`] };

      return { word: "refused", lines: [...greenLines, `#${options.pr} ${held.line}\n`] };
  }
}

async function baseDrift(
  number: string,
  facts: PullRequestFacts,
  reader: BaseReader,
): Promise<string[]> {
  try {
    const base = facts.baseRefName;
    const comparison = await reader.compareBase(
      facts.context,
      base,
      facts.headRefOid ?? facts.headRefName,
    );

    if (comparison.behindBy === 0) return [];

    const changed = new Set(await reader.changedFiles(facts.context));
    const touched = comparison.files.filter((path) => changed.has(path)).sort();
    return [
      `#${number} behind ${base} by ${comparison.behindBy}\n`,
      ...touched.map((path) => `#${number} base touched ${printable(path)}\n`),
    ];
  } catch (error) {
    return [
      `#${number} base overlap unread ${error instanceof Error ? error.message : String(error)}\n`,
    ];
  }
}

function printable(path: string): string {
  const quoted = JSON.stringify(path);
  return quoted.slice(1, -1) === path ? path : quoted;
}

type Hold = { word: "wait" | "refused"; line: string };

async function humanHold(
  number: string,
  facts: PullRequestFacts,
  reviewerLogins: readonly string[],
  gh: ReadRunner,
): Promise<Hold | null> {
  if (facts.reviewDecision === "CHANGES_REQUESTED")
    return { word: "refused", line: "changes requested" };

  const { pr, viewer, head } = await readHold(number, gh);
  if (head.oid !== facts.headRefOid)
    return { word: "wait", line: `head moved to ${head.oid.slice(0, 7)}` };

  if (pr.reviewDecision === "CHANGES_REQUESTED")
    return { word: "refused", line: "changes requested" };

  const human = newestHuman(pr, head, [pr.author?.login ?? "", viewer ?? "", ...reviewerLogins]);
  if (human !== null) return { word: "refused", line: `human ${human}` };

  return pr.reviewDecision === "REVIEW_REQUIRED"
    ? { word: "refused", line: "approval required" }
    : null;
}

async function readHold(number: string, gh: ReadRunner) {
  try {
    const read = await readPullRequest(number, gh);
    const head = read.pr.commits.nodes.at(-1)?.commit;
    if (!head) throw new Error("cannot parse PR snapshot");

    return { ...read, head };
  } catch (error) {
    if (error instanceof WatcherQueryError) throw error;

    throw new WatcherQueryError({
      kind: "json-parse",
      retryable: true,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function newestHuman(pr: PullRequest, head: Commit, excluded: readonly string[]): string | null {
  const arrival = headArrival(head);
  const ignored = new Set(excluded.map((login) => login.toLowerCase()));
  const activity = [
    ...pr.comments.nodes.map((comment) => ({
      author: comment.author,
      at: comment.createdAt,
      verb: "commented",
    })),
    ...pr.reviews.nodes
      .filter((review) => review.state !== "APPROVED" && review.state !== "DISMISSED")
      .map((review) => ({ author: review.author, at: review.submittedAt, verb: "reviewed" })),
  ].flatMap(({ author, at, verb }) => {
    const login = author?.login ?? "ghost";
    if (at === null || author?.__typename === "Bot" || ignored.has(login.toLowerCase())) return [];

    const time = timestamp(at, "cannot parse PR activity");
    return time > arrival ? [{ time, line: `${login} ${verb}` }] : [];
  });

  return (
    activity.reduce<{ time: number; line: string } | null>(
      (newest, entry) => (newest === null || entry.time >= newest.time ? entry : newest),
      null,
    )?.line ?? null
  );
}

export async function runDrive(args: readonly string[], deps: DriveDeps): Promise<CommandOutput> {
  let options: RoundOptions;
  try {
    options = parseRound(["decide", ...args]);
  } catch {
    return { code: 2, stdout: "", stderr: `usage: ${driveUsage}\n` };
  }

  const trace: Trace = { detail: [], facts: null };
  try {
    return output(await executeDrive(options, deps, trace), trace);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return output(
      {
        word: error instanceof WatcherQueryError && error.failure.retryable ? "wait" : "refused",
        lines: [
          error instanceof WatcherQueryError
            ? `#${options.pr} unreadable ${message}\n`
            : `${message}\n`,
        ],
      },
      trace,
    );
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

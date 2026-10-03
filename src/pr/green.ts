import { setTimeout as delay } from "node:timers/promises";
import { GhGitHubReader, resolveContext, WatcherQueryError } from "./github.ts";
import type * as T from "./types.ts";
import { nonEmpty, parsePrNumber } from "./types.ts";
import { reviewerDeclarations, type CliRuntime } from "./watch.ts";
import type { WatchClock } from "./policy.ts";

export type Hold =
  | { readonly kind: "pending"; readonly check: T.PendingCheck }
  | { readonly kind: "no-checks"; readonly head: string }
  | { readonly kind: "mergeable-unknown" }
  | { readonly kind: "unreadable"; readonly detail: string };

export type Fault =
  | { readonly kind: "blocked"; readonly rollup: string }
  | { readonly kind: "conflicting"; readonly mergeable: string; readonly mergeState: string }
  | { readonly kind: "failing"; readonly check: T.FailedCheck }
  | { readonly kind: "closed" };

export type Verdict =
  | { readonly kind: "green"; readonly head: string }
  | { readonly kind: "merged" }
  | { readonly kind: "red"; readonly faults: T.NonEmpty<Fault> }
  | { readonly kind: "waiting"; readonly holds: T.NonEmpty<Hold> };

export function judge(read: T.PrRead, reviewerChecks: readonly string[]): Verdict {
  const { facts } = read;
  if (facts.state === "MERGED" || facts.mergedAt !== null) return { kind: "merged" };
  if (facts.state === "CLOSED") return { kind: "red", faults: [{ kind: "closed" }] };
  if (facts.headRefOid === null)
    return {
      kind: "waiting",
      holds: [{ kind: "unreadable", detail: "PR head sha is unavailable" }],
    };

  const checks = read.checks.filter(
    (check) =>
      check.kind !== "code-review-gate" &&
      check.name !== "Code Review Gate" &&
      !reviewerChecks.some((name) => check.name.toLowerCase().includes(name.toLowerCase())),
  );

  const faults: Fault[] = [];
  const rollup = read.rollups.find((entry) => entry.oid === facts.headRefOid)?.state;
  if (facts.mergeStateStatus === "BLOCKED" && (rollup === "FAILURE" || rollup === "ERROR"))
    faults.push({ kind: "blocked", rollup });

  if (
    facts.mergeable === "CONFLICTING" ||
    ["DIRTY", "CONFLICTING", "BEHIND"].includes(facts.mergeStateStatus)
  )
    faults.push({
      kind: "conflicting",
      mergeable: facts.mergeable,
      mergeState: facts.mergeStateStatus,
    });

  for (const check of checks) if (check.kind === "failed") faults.push({ kind: "failing", check });

  const red = nonEmpty(faults);
  if (red !== null) return { kind: "red", faults: red };

  const holds: Hold[] = [];
  for (const check of checks) if (check.kind === "pending") holds.push({ kind: "pending", check });

  if (facts.mergeable === "UNKNOWN") holds.push({ kind: "mergeable-unknown" });
  if (checks.length === 0) holds.push({ kind: "no-checks", head: facts.headRefOid });

  const waiting = nonEmpty(holds);
  return waiting === null
    ? { kind: "green", head: facts.headRefOid }
    : { kind: "waiting", holds: waiting };
}

function findingLine(finding: Hold | Fault): string {
  switch (finding.kind) {
    case "blocked":
      return `blocked ${finding.rollup}`;

    case "closed":
      return "closed";

    case "conflicting":
      return `conflicting ${finding.mergeable} ${finding.mergeState}`;

    case "failing":
      return `failing ${finding.check.name} ${finding.check.link || "-"}`;

    case "pending":
      return `pending ${finding.check.name}`;

    case "no-checks":
      return `no checks yet on ${finding.head.slice(0, 7)}`;

    case "mergeable-unknown":
      return "mergeability unknown";

    case "unreadable":
      return `unreadable ${finding.detail.replace(/[\r\n]+/g, " ")}`;
  }
}

export function lines(number: T.PrNumber, verdict: Verdict): string[] {
  const findings =
    verdict.kind === "green"
      ? [`green ${verdict.head.slice(0, 7)}`]
      : verdict.kind === "merged"
        ? ["merged"]
        : (verdict.kind === "red" ? verdict.faults : verdict.holds).map(findingLine);

  return findings.map((finding) => `#${number} ${finding}`);
}

const usage = "skills pr green [<n>...] [--interval s] [--timeout s]";
export const NO_CHECKS_WINDOW_SECONDS = 120;
export const greenClock: WatchClock = {
  now: () => performance.now() / 1000,
  observedAt: () => new Date().toISOString(),
  sleep: async (seconds) => {
    await delay(seconds * 1000);
  },
};

type Options = { numbers: T.PrNumber[]; interval: number; timeout: number };

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { numbers: [], interval: 30, timeout: 1800 };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument.startsWith("-")) {
      const separator = argument.indexOf("=");
      const name = argument.slice(0, separator < 0 ? undefined : separator);
      if (name !== "--interval" && name !== "--timeout")
        throw new Error(`unknown option '${argument}'`);

      const value = separator < 0 ? argv[++index] : argument.slice(separator + 1);
      const seconds = Number(value);
      if (value === undefined || !Number.isFinite(seconds) || seconds <= 0)
        throw new Error(`${name} must be greater than zero`);

      options[name === "--interval" ? "interval" : "timeout"] = seconds;
    } else {
      if (!/^#?\d+$/.test(argument)) throw new Error(`invalid PR number '${argument}'`);

      const number = parsePrNumber(Number(argument.replace(/^#/, "")));
      if (options.numbers.includes(number)) throw new Error(`duplicate PR #${number}`);

      options.numbers.push(number);
    }
  }

  return options;
}

export async function main(
  argv: readonly string[],
  root: string,
  runtime?: CliRuntime,
): Promise<number> {
  const stdout = runtime?.stdout ?? ((value: string) => process.stdout.write(value));
  const stderr = runtime?.stderr ?? ((value: string) => process.stderr.write(value));

  if (argv.includes("--help") || argv.includes("-h")) {
    stdout(`Usage: ${usage}\n`);
    return 0;
  }

  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr(`error: ${error instanceof Error ? error.message : String(error)}\nusage: ${usage}\n`);
    return 2;
  }

  const reviewers = reviewerDeclarations(root);
  const clock = runtime?.clock ?? greenClock;

  const reader = runtime?.reader ?? new GhGitHubReader(reviewers);

  const contexts = new Map<T.PrNumber, T.PrContext>();
  if (options.numbers.length === 0) {
    try {
      const current = await resolveContext({ reader, owner: null, repo: null, pr: null });
      options.numbers.push(current.number);
      contexts.set(current.number, current);
    } catch (error) {
      if (!(error instanceof WatcherQueryError)) throw error;
      stderr(`unreadable ${error.message}\n`);
      return 1;
    }
  }

  const result = await waitForGreen(
    options.numbers.map((number) => contexts.get(number) ?? number),
    reader,
    clock,
    reviewers.checks,
    options.interval,
    options.timeout,
    (progress) => stderr(`waiting: ${progress}\n`),
  );

  stdout(`${result.lines.join("\n")}\n`);
  return result.code;
}

export async function waitForGreen(
  targets: readonly (T.PrContext | T.PrNumber)[],
  reader: T.GitHubReader,
  clock: WatchClock,
  reviewerChecks: readonly string[],
  interval: number,
  timeout: number,
  progress: (line: string) => void = () => {},
): Promise<{ lines: string[]; code: number }> {
  const deadline = clock.now() + timeout;
  const contexts = new Map<T.PrNumber, T.PrContext>();
  const noChecks = new Map<T.PrNumber, { head: string; since: number }>();

  let candidate: readonly (string | null)[] | undefined;
  for (;;) {
    const pass: { number: T.PrNumber; head: string | null; verdict: Verdict }[] = [];

    let unreadable = false;
    for (const target of targets) {
      const number = typeof target === "number" ? target : target.number;
      try {
        const context =
          contexts.get(number) ??
          (typeof target === "number"
            ? await resolveContext({ reader, owner: null, repo: null, pr: number })
            : target);

        contexts.set(number, context);

        const read = await reader.read(context);
        let verdict = judge(read, reviewerChecks);
        const missing =
          verdict.kind === "waiting"
            ? verdict.holds.find((hold) => hold.kind === "no-checks")
            : undefined;

        if (missing?.kind === "no-checks") {
          const previous = noChecks.get(number);
          const observation =
            previous?.head === missing.head ? previous : { head: missing.head, since: clock.now() };

          noChecks.set(number, observation);

          if (
            clock.now() - observation.since >= NO_CHECKS_WINDOW_SECONDS &&
            verdict.kind === "waiting"
          ) {
            const holds = nonEmpty(verdict.holds.filter((hold) => hold.kind !== "no-checks"));
            verdict =
              holds === null ? { kind: "green", head: missing.head } : { kind: "waiting", holds };
          }
        } else noChecks.delete(number);

        pass.push({ number, head: read.facts.headRefOid, verdict });
      } catch (error) {
        if (!(error instanceof WatcherQueryError)) throw error;

        unreadable ||= !error.failure.retryable;
        noChecks.delete(number);

        pass.push({
          number,
          head: null,
          verdict: { kind: "waiting", holds: [{ kind: "unreadable", detail: error.message }] },
        });
      }
    }

    const output = pass.flatMap((row) => lines(row.number, row.verdict));
    const red = pass.some((row) => row.verdict.kind === "red");
    const ready = pass.every(
      (row) => row.verdict.kind === "green" || row.verdict.kind === "merged",
    );

    const confirmed = ready && candidate?.every((head, index) => head === pass[index]!.head);
    if (red || unreadable || confirmed || (!ready && clock.now() + interval > deadline))
      return { lines: output, code: confirmed && !red && !unreadable ? 0 : 1 };

    candidate = ready ? pass.map((row) => row.head) : undefined;

    const waiting = pass.find((row) => row.verdict.kind === "waiting");
    const finding = waiting === undefined ? output[0] : lines(waiting.number, waiting.verdict)[0];
    if (finding !== undefined) progress(finding);
    await clock.sleep(interval);
  }
}

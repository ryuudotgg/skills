import { mkdtemp } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Suite } from "../registry.ts";
import { liveReporter, liveView, type LiveOptions, type Reporter } from "./progress.ts";
import {
  removeTemporary,
  runCommand,
  suiteEnvironment,
  withInterrupts,
  type CommandResult,
} from "./process.ts";
import {
  failedTests,
  failingFiles,
  flakyTests,
  namesEveryFailure,
  readReport,
  rerunnable,
  type Report,
  type Rerunnable,
  type Tests,
} from "./report.ts";

export type RunnerOptions = {
  jobs?: number;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  signal?: AbortSignal;
  live?: LiveOptions;
};

type Attempt = { result: CommandResult; seconds: number; report: Report | undefined };

type Held = {
  suite: Suite;
  command: Rerunnable;
  cwd: string;
  failing: readonly [file: string, tests: Tests][];
  seconds: number;
  output: string;
};

const mostFiles = 5;

export function defaultJobs(): number {
  return Math.max(1, Math.floor(availableParallelism() / 2));
}

function pipedReporter(
  count: number,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
): Reporter {
  let failures = 0;
  let flaky = 0;

  return {
    start() {},
    hold() {},
    finish(suite, outcome) {
      stdout(`${outcome.failed ? "FAIL" : "ok"} ${suite.name} ${outcome.seconds.toFixed(1)}s\n`);
      for (const test of outcome.flaky) stdout(`flaky ${test}\n`);

      flaky += outcome.flaky.length;
      if (!outcome.failed) return;

      failures += 1;
      stderr(outcome.output);
    },
    end(complete) {
      if (!complete) return;
      const passed = `ok ${count} suites${flaky ? `, ${flaky} flaky` : ""}\n`;
      stdout(failures === 0 ? passed : `FAIL ${failures} of ${count} suites\n`);
    },
  };
}

function cap(suite: Suite): number {
  return (suite.timeout ?? 600) * 1000;
}

function output(suite: Suite, { stdout, stderr, timedOut }: CommandResult): string {
  return `${stdout}${stderr}${timedOut ? `${suite.name}: timed out\n` : ""}`;
}

async function scratch<T>(prefix: string, use: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await use(directory);
  } finally {
    await removeTemporary(directory);
  }
}

function attempt(
  cwd: string,
  argv: (report: string) => readonly string[],
  timeout: number,
  signal: AbortSignal,
): Promise<Attempt> {
  return scratch("skills-suite-", (temporary) =>
    scratch("skills-report-", async (reports) => {
      const report = join(reports, "junit.xml");
      const started = performance.now();
      const result = await runCommand(argv(report), {
        cwd,
        env: { ...suiteEnvironment(), TMPDIR: temporary },
        timeout,
        signal,
      });

      const seconds = (performance.now() - started) / 1000;
      return { result, seconds, report: await readReport(report, cwd) };
    }),
  );
}

async function runSuite(
  repo: string,
  suite: Suite,
  signal: AbortSignal,
  reporter: Reporter,
): Promise<boolean | Held> {
  const cwd = join(repo, suite.cwd ?? "");
  const command = rerunnable(suite.argv);
  reporter.start(suite);

  const first = await attempt(
    cwd,
    (report) => command?.first(report) ?? suite.argv,
    cap(suite),
    signal,
  );

  if (signal.aborted) return false;

  const { result, seconds, report } = first;
  const text = output(suite, result);
  const failing = report ? failingFiles(report) : [];
  const flaky = !result.timedOut && failing.length <= mostFiles;
  if (command && report && flaky && namesEveryFailure(report, result)) {
    reporter.hold(suite, seconds);
    return { suite, command, cwd, failing, seconds, output: text };
  }

  const failed = result.code !== 0 || result.timedOut;
  reporter.finish(suite, { failed, seconds, output: text, flaky: [] });
  return failed;
}

async function rerun(
  repo: string,
  { suite, command, cwd, failing, ...first }: Held,
  signal: AbortSignal,
  reporter: Reporter,
): Promise<boolean> {
  const flaky: string[] = [];

  let { seconds, output: text } = first;
  let clean = true;
  for (const [file, tests] of failing) {
    if (signal.aborted) break;

    const name = relative(repo, file);
    const left = cap(suite) - seconds * 1000;
    if (left <= 0) {
      text += `${suite.name}: no time left to rerun ${name}\n`;
      continue;
    }

    const again = await attempt(cwd, (path) => command.rerun(path, file), left, signal);
    seconds += again.seconds;
    text += `${suite.name}: rerun ${name}\n${output(suite, again.result)}`;
    clean &&= again.result.code === 0 && !again.result.timedOut;
    if (signal.aborted) break;

    const passed = flakyTests(tests, again.report?.get(file));
    flaky.push(...passed.map((test) => `${name}: ${test}`));
  }

  const named = failing.flatMap(([, tests]) => failedTests(tests)).length;
  const failed = !clean || flaky.length < named;
  reporter.finish(suite, { failed, seconds, output: text, flaky });
  return failed;
}

async function executeSuites(
  repo: string,
  suites: readonly Suite[],
  signal: AbortSignal,
  options: RunnerOptions,
): Promise<number> {
  const queue = [...suites].sort((left, right) => right.seconds - left.seconds);
  const jobs = options.jobs ?? defaultJobs();
  if (!Number.isSafeInteger(jobs) || jobs < 1) throw new Error("jobs must be a positive integer");

  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  const live = options.live ?? (options.stdout ? undefined : liveView());
  const reporter = live
    ? liveReporter(repo, queue, stdout, live)
    : pipedReporter(suites.length, stdout, stderr);

  let failures = 0;
  const held: Held[] = [];
  const worker = async () => {
    while (!signal.aborted) {
      const suite = queue.shift();
      if (!suite) return;

      const first = await runSuite(repo, suite, signal, reporter);
      if (typeof first === "object") held.push(first);
      else if (first) failures += 1;
    }
  };

  let complete = false;
  try {
    await Promise.all(Array.from({ length: Math.min(jobs, suites.length) }, worker));
    for (const suite of held) if (await rerun(repo, suite, signal, reporter)) failures += 1;
    complete = !signal.aborted;
  } finally {
    reporter.end(complete);
  }

  if (signal.aborted) return 130;

  return failures === 0 ? 0 : 1;
}

export async function runSuites(
  repo: string,
  suites: readonly Suite[],
  options: RunnerOptions = {},
): Promise<number> {
  if (options.signal) return executeSuites(repo, suites, options.signal, options);
  return withInterrupts((signal) => executeSuites(repo, suites, signal, options));
}

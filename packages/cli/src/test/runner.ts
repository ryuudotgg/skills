import { mkdtemp } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import type { Suite } from "../registry.ts";
import { liveReporter, liveView, type LiveOptions, type Reporter } from "./progress.ts";
import { removeTemporary, runCommand, suiteEnvironment, withInterrupts } from "./process.ts";

export type RunnerOptions = {
  jobs?: number;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  signal?: AbortSignal;
  live?: LiveOptions;
};

export function defaultJobs(): number {
  return Math.max(1, Math.floor(availableParallelism() / 2));
}

function pipedReporter(
  count: number,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
): Reporter {
  let failures = 0;

  return {
    start() {},
    finish(suite, { failed, seconds, result }) {
      stdout(`${failed ? "FAIL" : "ok"} ${suite.name} ${seconds.toFixed(1)}s\n`);
      if (!failed) return;

      failures += 1;
      stderr(result.stdout);
      stderr(result.stderr);
      if (result.timedOut) stderr(`${suite.name}: timed out\n`);
    },
    end(complete) {
      if (!complete) return;
      stdout(failures === 0 ? `ok ${count} suites\n` : `FAIL ${failures} of ${count} suites\n`);
    },
  };
}

async function runSuite(repo: string, suite: Suite, signal: AbortSignal, reporter: Reporter) {
  const temporary = await mkdtemp(join(tmpdir(), "skills-suite-"));
  const started = performance.now();
  reporter.start(suite);

  try {
    const result = await runCommand(suite.argv, {
      cwd: join(repo, suite.cwd ?? ""),
      env: { ...suiteEnvironment(), TMPDIR: temporary },
      timeout: (suite.timeout ?? 600) * 1000,
      signal,
    });

    const failed = result.code !== 0 || result.timedOut;

    if (signal.aborted) return false;

    reporter.finish(suite, { failed, seconds: (performance.now() - started) / 1000, result });
    return failed;
  } finally {
    await removeTemporary(temporary);
  }
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
  const worker = async () => {
    while (!signal.aborted) {
      const suite = queue.shift();
      if (!suite) return;
      if (await runSuite(repo, suite, signal, reporter)) failures += 1;
    }
  };

  let complete = false;
  try {
    await Promise.all(Array.from({ length: Math.min(jobs, suites.length) }, worker));
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

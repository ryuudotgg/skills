import { mkdtemp } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import type { Suite } from "../registry.ts";
import { removeTemporary, runCommand, suiteEnvironment, withInterrupts } from "./process.ts";

export type RunnerOptions = {
  jobs?: number;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  signal?: AbortSignal;
};

export function defaultJobs(): number {
  return Math.max(1, Math.floor(availableParallelism() / 2));
}

async function runSuite(repo: string, suite: Suite, signal: AbortSignal, options: RunnerOptions) {
  const temporary = await mkdtemp(join(tmpdir(), "skills-suite-"));
  const started = performance.now();
  try {
    const result = await runCommand(suite.argv, {
      cwd: join(repo, suite.cwd ?? ""),
      env: { ...suiteEnvironment(), TMPDIR: temporary },
      timeout: (suite.timeout ?? 600) * 1000,
      signal,
    });

    const failed = result.code !== 0 || result.timedOut;

    if (signal.aborted) return false;

    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
    const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
    stdout(`${failed ? "FAIL" : "ok"} ${suite.name} ${seconds}s\n`);

    if (failed) {
      stderr(result.stdout);
      stderr(result.stderr);
      if (result.timedOut) stderr(`${suite.name}: timed out\n`);
    }

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

  let failures = 0;
  const worker = async () => {
    while (!signal.aborted) {
      const suite = queue.shift();
      if (!suite) return;
      if (await runSuite(repo, suite, signal, options)) failures += 1;
    }
  };

  await Promise.all(Array.from({ length: Math.min(jobs, suites.length) }, worker));

  if (signal.aborted) return 130;

  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  stdout(
    failures === 0
      ? `ok ${suites.length} suites\n`
      : `FAIL ${failures} of ${suites.length} suites\n`,
  );

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

import { semver } from "bun";
import packageInfo from "../../package.json";
import { testUsage as usage } from "../areas/install.ts";
import type { Context } from "../registry.ts";
import { checkManifest } from "./manifest.ts";
import { defaultJobs, runSuites } from "./runner.ts";
import { selectSuites } from "./selection.ts";

type Mode =
  | { kind: "diff" | "all" | "list" }
  | { kind: "named"; names: readonly string[] };

type TestOptions = { mode: Mode; jobs: number };

export function parseTestOptions(args: readonly string[]): TestOptions {
  let kind: "diff" | "all" | "list" = "diff";
  let jobs = defaultJobs();
  const names: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--jobs") {
      const value = args[++index];
      if (!value || value.startsWith("--"))
        throw new Error(`${arg} needs a value`);

      jobs = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(jobs) || jobs < 1)
        throw new Error("--jobs needs a positive integer");
    } else if (arg === "--all" || arg === "--list") {
      if (kind !== "diff")
        throw new Error("choose one test mode");
      kind = arg === "--all" ? "all" : "list";
    } else if (arg?.startsWith("-"))
      throw new Error(`unknown test option: ${arg}`);
    else if (arg)
      names.push(arg);
  }

  if (names.length > 0 && kind !== "diff")
    throw new Error("suite names cannot be combined with a test mode");

  return { mode: names.length > 0 ? { kind: "named", names } : { kind }, jobs };
}

async function executeTest(options: TestOptions, ctx: Context): Promise<number> {
  const { mode, jobs } = options;

  const selected =
    mode.kind === "all"
      ? ctx.suites
      : mode.kind === "named"
        ? mode.names.map((name) => {
            const suite = ctx.suites.find((row) => row.name === name);
            if (!suite)
              throw new Error(`unknown suite: ${name}`);
            return suite;
          })
        : await selectSuites(ctx.repo, ctx.suites);

  if (mode.kind === "list") {
    for (const suite of selected)
      process.stdout.write(`${suite.name}\n`);
    return 0;
  }

  const problems = await checkManifest(ctx.repo, ctx.suites);
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    return 1;
  }

  return runSuites(ctx.repo, [...new Set(selected)], { jobs });
}

export async function runTest(args: readonly string[], ctx: Context): Promise<number> {
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(`${usage}\n`);
    return 0;
  }

  if (!semver.satisfies(Bun.version, packageInfo.engines.bun)) {
    process.stderr.write(`test: Bun ${packageInfo.engines.bun} required, found ${Bun.version}\n`);
    return 1;
  }

  let options: TestOptions;
  try {
    options = parseTestOptions(args);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage}\n`);
    return 2;
  }

  return executeTest(options, ctx);
}

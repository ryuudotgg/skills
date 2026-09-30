import { semver } from "bun";
import packageInfo from "../../package.json";
import type { Context, Verb } from "../registry.ts";
import { checkManifest } from "./manifest.ts";
import { runParity, type Stub } from "./parity.ts";
import { defaultJobs, runSuites } from "./runner.ts";
import { selectSuites } from "./selection.ts";

type Mode =
  | { kind: "diff" | "all" | "list" }
  | { kind: "named"; names: readonly string[] }
  | { kind: "parity"; suite: string; stubs: readonly Stub[] };

type TestOptions = { mode: Mode; jobs: number };

const usage =
  "skills test [--all | --list | --parity <suite> [--stub <path>=<command>]... | <name>...] [--jobs <n>]";

function parseStub(value: string): Stub {
  const separator = value.indexOf("=");
  if (separator < 1 || separator === value.length - 1) {
    throw new Error("--stub needs <path>=<command>");
  }

  return { legacy: value.slice(0, separator), command: value.slice(separator + 1) };
}

export function parseTestOptions(args: readonly string[]): TestOptions {
  let kind: "diff" | "all" | "list" | "parity" = "diff";
  let jobs = defaultJobs();
  let suite = "";
  const names: string[] = [];
  const stubs: Stub[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--jobs" || arg === "--stub" || arg === "--parity") {
      const value = args[++index];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} needs a value`);
      }

      if (arg === "--jobs") {
        jobs = Number(value);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(jobs) || jobs < 1) {
          throw new Error("--jobs needs a positive integer");
        }
      } else if (arg === "--stub") {
        stubs.push(parseStub(value));
      } else {
        if (kind !== "diff") {
          throw new Error("choose one test mode");
        }

        kind = "parity";
        suite = value;
      }
    } else if (arg === "--all" || arg === "--list") {
      if (kind !== "diff") {
        throw new Error("choose one test mode");
      }

      kind = arg === "--all" ? "all" : "list";
    } else if (arg?.startsWith("-")) {
      throw new Error(`unknown test option: ${arg}`);
    } else if (arg) {
      names.push(arg);
    }
  }

  if (names.length > 0 && kind !== "diff") {
    throw new Error("suite names cannot be combined with a test mode");
  }

  if (stubs.length > 0 && kind !== "parity") {
    throw new Error("--stub requires --parity");
  }

  if (kind === "parity") {
    return { mode: { kind, suite, stubs }, jobs };
  }

  return { mode: names.length > 0 ? { kind: "named", names } : { kind }, jobs };
}

async function executeTest(options: TestOptions, ctx: Context): Promise<number> {
  const { mode, jobs } = options;
  if (mode.kind === "parity") {
    return runParity(ctx, mode.suite, { jobs, stubs: () => mode.stubs });
  }

  const selected =
    mode.kind === "all"
      ? ctx.suites
      : mode.kind === "named"
        ? mode.names.map((name) => {
            const suite = ctx.suites.find((row) => row.name === name);
            if (!suite) {
              throw new Error(`unknown suite: ${name}`);
            }

            return suite;
          })
        : await selectSuites(ctx.repo, ctx.suites);
  if (mode.kind === "list") {
    for (const suite of selected) {
      process.stdout.write(`${suite.name}\n`);
    }

    return 0;
  }

  const problems = await checkManifest(ctx.repo, ctx.suites);
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);

    return 1;
  }

  return runSuites(ctx.repo, [...new Set(selected)], { jobs });
}

async function runTest(args: readonly string[], ctx: Context): Promise<number> {
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

export const testVerb: Verb = {
  name: ["test"],
  usage,
  grammar: [
    "ok <name> <seconds>s",
    "FAIL <name> <seconds>s",
    "ok <n> suites",
    "FAIL <k> of <n> suites",
    "<name>",
  ],
  run: runTest,
};

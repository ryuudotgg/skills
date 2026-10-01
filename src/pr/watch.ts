import { setTimeout as delay } from "node:timers/promises";
import { readDeclarations } from "../reviewers/declaration.ts";
import {
  GhGitHubReader,
  WatcherQueryError,
  discoverStack,
  resolveContext,
} from "./github.ts";
import {
  runQueued,
  runSimple,
  statusQueryVerdict,
  verdictFactory,
  type WatchClock,
} from "./policy.ts";
import { renderJson, renderPretty } from "./render.ts";
import type * as T from "./types.ts";
import { nonEmpty, parsePrNumber } from "./types.ts";
export interface CliOptions {
  readonly owner: string | null;
  readonly repo: string | null;
  readonly pr: T.PrNumber | null;
  readonly mode: T.WatchMode;
  readonly stackPrs: readonly T.PrNumber[];
  readonly statusOnly: boolean;
  readonly pretty: boolean;
  readonly polling: T.PollingOptions;
}
function positiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new UsageError("must be greater than zero");

  return parsed;
}
function nonNegativeNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new UsageError("must be zero or greater");

  return parsed;
}
function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new UsageError("must be a positive integer");

  return parsed;
}
function prNumber(value: string): T.PrNumber {
  try {
    return parsePrNumber(Number(value.replace(/^#/, "")));
  } catch {
    throw new UsageError("must be a positive integer");
  }
}
function stackPrList(value: string): T.NonEmpty<T.PrNumber> {
  const numbers = value.split(",").map((part) => prNumber(part.trim()));
  if (new Set(numbers).size !== numbers.length)
    throw new UsageError("contains a duplicate PR");

  const parsed = nonEmpty(numbers);
  if (parsed === null) throw new UsageError("cannot be empty");
  return parsed;
}
class UsageError extends Error {}
class HelpRequested extends Error {}
export function reviewerDeclarations(root: string): T.ReviewerDeclarations {
  const declarations = readDeclarations(root);
  return {
    checks: declarations.map((declaration) => declaration.check),
    logins: declarations.flatMap((declaration) => declaration.logins),
    outsideDiffHeadings: declarations.flatMap((declaration) =>
      declaration.outsideDiff === undefined ? [] : [declaration.outsideDiff]
    ),
  };
}
export function parseArgs(
  argv: readonly string[],
  io: Pick<CliRuntime, "stdout" | "stderr">
): CliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const booleanFlags = ["stack", "queued-stack", "status-only", "allow-draft", "pretty", "help"];
  const valueFlags = ["owner", "repo", "pr", "stack-prs", "interval", "sweep-interval", "timeout", "max-query-errors"];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] === "-h" ? "--help" : argv[index]!;
    if (!argument.startsWith("--")) throw new UsageError(`unexpected argument '${argument}'`);

    const separator = argument.indexOf("=");
    const name = argument.slice(2, separator < 0 ? undefined : separator);
    if (booleanFlags.includes(name)) {
      if (separator >= 0) throw new UsageError(`option '--${name}' does not take a value`);
      if (name === "help") {
        io.stdout("Usage: skills pr watch [options]\nWatch one pull request, a connected stack, or an immutable queued stack.\nJSON (NDJSON while polling) is the default; --pretty renders human text.\n" +
          valueFlags.map((flag) => `  --${flag} <value>`).join("\n") + "\n" +
          booleanFlags.map((flag) => `  --${flag}`).join("\n") + "\n");

        throw new HelpRequested();
      }

      flags.add(name);
      continue;
    }

    if (!valueFlags.includes(name)) throw new UsageError(`unknown option '--${name}'`);

    const value = separator < 0 ? argv[++index] : argument.slice(separator + 1);
    if (value === undefined || value.startsWith("--"))
      throw new UsageError(`option '--${name}' argument missing`);

    values.set(name, value);
  }

  if (flags.has("stack") && flags.has("queued-stack"))
    throw new UsageError("--stack conflicts with --queued-stack");

  if (values.has("stack-prs") && !flags.has("queued-stack"))
    throw new UsageError("--stack-prs requires --queued-stack");

  const parsed = <Value>(name: string, label: string, parse: (value: string) => Value, fallback: Value): Value => {
    const value = values.get(name);
    if (value === undefined) return fallback;

    try {
      return parse(value);
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      throw new UsageError(`option '--${name} <${label}>' argument '${value}' is invalid: ${error.message}`);
    }
  };

  return {
    owner: values.get("owner") ?? null,
    repo: values.get("repo") ?? null,
    pr: parsed<T.PrNumber | null>("pr", "number", prNumber, null),
    mode: flags.has("queued-stack") ? "queued-stack" : flags.has("stack") ? "stack" : "single",
    stackPrs: parsed<readonly T.PrNumber[]>("stack-prs", "n,...", stackPrList, []),
    statusOnly: flags.has("status-only"),
    pretty: flags.has("pretty"),
    polling: {
      interval: parsed("interval", "seconds", positiveNumber, 60),
      sweepInterval: parsed("sweep-interval", "seconds", positiveNumber, 300),
      timeout: parsed("timeout", "seconds", nonNegativeNumber, 0),
      maxQueryErrors: parsed("max-query-errors", "count", positiveInteger, 5),
      allowDraft: flags.has("allow-draft"),
    },
  };
}
export interface CliRuntime {
  readonly reader: T.GitHubReader;
  readonly clock: WatchClock;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}
function realRuntime(reviewers: T.ReviewerDeclarations): CliRuntime {
  return {
    reader: new GhGitHubReader(reviewers),
    clock: {
      now: () => performance.now() / 1_000,
      observedAt: () => new Date().toISOString(),
      sleep: async (seconds) => {
        await delay(seconds * 1_000);
      },
    },
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  };
}
export async function main(
  argv: readonly string[],
  root: string | T.ReviewerDeclarations,
  runtime?: CliRuntime
): Promise<number> {
  const io = runtime ?? {
    stdout: (value: string) => { process.stdout.write(value); },
    stderr: (value: string) => { process.stderr.write(value); },
  };

  let options: CliOptions;
  try {
    options = parseArgs(argv, io);
  } catch (error) {
    if (error instanceof HelpRequested) return 0;
    if (!(error instanceof UsageError)) throw error;

    io.stderr(`error: ${error.message}\n`);
    return 64;
  }

  const reviewers = typeof root === "string" ? reviewerDeclarations(root) : root;
  const activeRuntime = runtime ?? realRuntime(reviewers);
  const reviewerChecks = reviewers.checks;

  const render = options.pretty ? renderPretty : renderJson;
  const emit = (verdict: T.ProgressVerdict): void =>
    activeRuntime.stdout(render(verdict));

  let contexts: T.NonEmpty<T.PrContext>;
  try {
    const seed = await resolveContext({
      reader: activeRuntime.reader,
      owner: options.owner,
      repo: options.repo,
      pr: options.pr ?? options.stackPrs[0] ?? null,
    });

    contexts =
      nonEmpty(options.stackPrs.map((number) => ({ ...seed, number }))) ??
      (options.mode === "single"
        ? [seed]
        : await discoverStack(activeRuntime.reader, seed));
  } catch (error) {
    if (!(error instanceof WatcherQueryError)) throw error;

    const verdict = statusQueryVerdict(
      verdictFactory(activeRuntime.clock, options.mode),
      1,
      error.failure
    );

    activeRuntime.stdout(render(verdict));
    return verdict.exitCode;
  }

  const dependencies = {
    reader: activeRuntime.reader,
    reviewerChecks,
    clock: activeRuntime.clock,
    emit,
  };

  const verdict =
    options.mode === "queued-stack" && !options.statusOnly
      ? await runQueued({ dependencies, contexts, options: options.polling })
      : await runSimple({
          dependencies,
          contexts,
          mode: options.mode,
          statusOnly: options.statusOnly,
          options: options.polling,
        });

  activeRuntime.stdout(render(verdict));
  return verdict.exitCode;
}

import { join } from "node:path";
import { describe, read } from "../read.ts";
import { pathToFileURL } from "node:url";
import { readDelivery } from "../delivery.ts";
import {
  isFile,
  readDeclarations,
  reviewerName,
  type Declaration,
} from "../reviewers/declaration.ts";
import { readSettingsSources, resolveSettings } from "../reviewers/settings.ts";
import { branchTip, readFixes } from "./fixes.ts";
import { limits, presence } from "./presence.ts";
import { readSnapshot } from "./snapshot.ts";
import type {
  CommandOutput,
  Comment,
  Dependencies,
  ReadResult,
  Reviewer,
  ReviewerInput,
  Snapshot,
  Verdict,
} from "./types.ts";

export const roundUsage =
  "usage: skills round gate <pr> [--wait] [critical=true] | skills round decide <pr> <branch> [critical=true] [<reviewer>=fixed|<reviewer>=dismissed ...]";
export type RoundOptions = {
  phase: "gate" | "decide";
  pr: string;
  branch: string;
  wait: boolean;
  critical: boolean;
  outcomes: Map<string, "fixed" | "dismissed">;
};

export function parseRound(args: readonly string[]): RoundOptions {
  const [phase, pr, ...options] = args;
  if ((phase !== "gate" && phase !== "decide") || !pr || !/^\d+$/.test(pr))
    throw new Error(roundUsage);

  const branch = phase === "decide" ? options.shift() : "";
  if (
    branch === undefined ||
    (phase === "decide" && (!branch || branch.startsWith("-") || branch.includes("=")))
  )
    throw new Error(roundUsage);

  let wait = false;
  let critical = false;
  const outcomes = new Map<string, "fixed" | "dismissed">();
  for (const option of options)
    if (option === "--wait" && phase === "gate" && !wait) wait = true;
    else if (option === "critical=true" && !critical) critical = true;
    else {
      const match = /^(.+)=(fixed|dismissed)$/.exec(option);
      if (phase !== "decide" || !match || !reviewerName.test(match[1]!) || outcomes.has(match[1]!))
        throw new Error(roundUsage);

      outcomes.set(match[1]!, match[2] as "fixed" | "dismissed");
    }

  return { phase, pr, branch, wait, critical, outcomes };
}

export function validVerdict(output: string): output is Verdict {
  return (
    /^(absent|wait|triage|done|rereview|handback|unavailable)( [a-z0-9-]+)*$/.test(output) &&
    !/[\r\n]/.test(output) &&
    output !== "handback" &&
    output !== "unavailable"
  );
}

export function fold(verdicts: readonly { name: string; verdict: Verdict }[]): string {
  const handbacks = verdicts.filter((entry) => entry.verdict.startsWith("handback "));
  if (handbacks.length)
    return `handback ${handbacks.map((entry) => `${entry.name} ${entry.verdict.slice(9)}`).join(", ")}`;

  for (const word of ["wait", "triage", "rereview", "done"])
    if (verdicts.some((entry) => entry.verdict.split(" ")[0] === word)) return word;

  const unavailable = verdicts.filter((entry) => entry.verdict.startsWith("unavailable "));
  return unavailable.length
    ? `handback ${unavailable.map((entry) => `${entry.name} ${entry.verdict}`).join(", ")}`
    : "done";
}

async function portedVerdict(
  reviewer: Reviewer<{ fixesFrom: string | null }>,
  declaration: Declaration,
  options: RoundOptions,
  settings: Record<string, string>,
  snapshot: Promise<Snapshot | null>,
  deps: Dependencies,
): Promise<Verdict> {
  const data = await snapshot;
  if (data === null) return "handback refused";

  const now =
    deps.env.REVIEW_NOW || new Date(deps.clock() * 1000).toISOString().replace(".000Z", "Z");

  const input: ReviewerInput = {
    phase: options.phase,
    outcome: options.outcomes.get(declaration.name) ?? null,
    critical: options.critical,
    snapshot: data,
    presence: presence(data, declaration, now),
    declaration,
    settings,
    limits,
    now,
  };

  const facts = reviewer.facts(input);

  let fixes = null;
  if (input.phase === "decide" && input.outcome !== null && facts.fixesFrom !== null)
    if (input.outcome === "dismissed") fixes = { commits: 0, lines: 0, added: 0, moved: false };
    else if ((await branchTip(options.branch, deps.git)) !== facts.fixesFrom)
      fixes = await readFixes(facts.fixesFrom, options.branch, deps.git);

  const verdict = reviewer.decide(facts, fixes, input);
  if (!validVerdict(verdict)) throw new Error("returned an invalid verdict");

  return verdict;
}

async function executeRound(options: RoundOptions, deps: Dependencies): Promise<CommandOutput> {
  let declarations: Declaration[];
  try {
    declarations = readDeclarations(deps.root);
  } catch (error) {
    return {
      code: 1,
      stdout: "",
      stderr: `${error instanceof Error ? error.message : String(error)}\nround: cannot read active reviewers\n`,
    };
  }

  const delivery = readDelivery(deps.root, deps.env);
  const active = declarations.filter(
    (entry) => delivery.mode === "prs" && delivery.active.includes(entry.name),
  );

  if (!active.length)
    return options.outcomes.size
      ? { code: 2, stdout: "", stderr: `${roundUsage}\n` }
      : { code: 0, stdout: "done\n", stderr: "" };

  if ([...options.outcomes.keys()].some((name) => !active.some((entry) => entry.name === name)))
    return { code: 2, stdout: "", stderr: `${roundUsage}\n` };

  const note = (text: string) => {
    deps.stderr!(
      text
        .replace(/\n$/, "")
        .split("\n")
        .map((line) => `round: ${line}\n`)
        .join(""),
    );
  };

  const reviewers = new Map<string, Reviewer<{ fixesFrom: string | null }>>();
  for (const entry of active) {
    const path = join(deps.root, entry.name, "reviewer.ts");
    if (!isFile(path)) {
      note(`${entry.name} has no reviewer.ts`);
      continue;
    }

    try {
      reviewers.set(entry.name, await import(pathToFileURL(path).href));
    } catch (error) {
      note(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const headChecks = [
    ...new Set([...reviewers.values()].flatMap((reviewer) => reviewer.headChecks ?? [])),
  ];

  const resolved = new Map<string, Record<string, string>>();
  if (reviewers.size) {
    const sources = await readSettingsSources(declarations, deps.env, deps.git);
    for (const entry of active.filter((entry) => reviewers.has(entry.name))) {
      const settings = resolveSettings(entry, true, sources);
      resolved.set(entry.name, settings.values);
      for (const message of settings.notes) deps.stderr!(`settings: ${message}\n`);
    }
  }

  const deadline = Math.floor(deps.clock()) + limits.start + limits.cap;

  let combined: string;
  let verdicts: { name: string; verdict: Verdict }[];
  let comments: Comment[] = [];
  do {
    const snapshot = reviewers.size
      ? readSnapshot(options.pr, deps.gh, note, headChecks, comments).catch((error) => {
          note(error instanceof Error ? error.message : String(error));
          return null;
        })
      : Promise.resolve(null);

    verdicts = await Promise.all(
      active.map(async (entry) => {
        try {
          const reviewer = reviewers.get(entry.name);
          return {
            name: entry.name,
            verdict: reviewer
              ? await portedVerdict(
                  reviewer,
                  entry,
                  options,
                  resolved.get(entry.name)!,
                  snapshot,
                  deps,
                )
              : ("handback refused" as const),
          };
        } catch (error) {
          note(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
          return { name: entry.name, verdict: "handback refused" as const };
        }
      }),
    );

    comments = (await snapshot)?.comments ?? comments;
    combined = fold(verdicts);
    if (combined !== "wait") break;
    if (
      options.phase === "decide"
        ? !verdicts.some((entry) => entry.verdict === "wait check-appear")
        : !options.wait
    )
      break;

    const remaining = deadline - Math.floor(deps.clock());
    if (remaining <= 0) break;

    const poll = deps.env.ROUND_POLL ?? "";
    const seconds = /^[1-9]\d*$/.test(poll) ? Number(poll) : 30;
    await deps.sleep(Math.min(seconds, remaining));
  } while (Math.floor(deps.clock()) < deadline);

  return {
    code: 0,
    stdout: `${verdicts.map((entry) => `${entry.name} ${entry.verdict}\n`).join("")}${combined}\n`,
    stderr: "",
  };
}

export async function runRound(
  args: readonly string[],
  deps: Dependencies,
): Promise<CommandOutput> {
  let stderr = "";
  const emit = (text: string) => {
    if (!text) return;
    stderr += text;
    deps.stderr?.(text);
  };

  let options: RoundOptions;
  try {
    options = parseRound(args);
  } catch {
    emit(`${roundUsage}\n`);
    return { code: 2, stdout: "", stderr };
  }

  try {
    const result = await executeRound(options, { ...deps, stderr: emit });
    emit(result.stderr);
    return { ...result, stderr };
  } catch (error) {
    emit(`round: ${error instanceof Error ? error.message : String(error)}\n`);

    return {
      code: 1,
      stdout: "",
      stderr,
    };
  }
}

export function dependencies(
  root: string,
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Dependencies {
  const spawn = async (args: readonly string[], deadline: number): Promise<ReadResult> => {
    const result = await read(args, { cwd, env, deadline });
    return result.ok
      ? { code: result.code, stdout: result.stdout, stderr: result.stderr }
      : { code: -1, stdout: "", stderr: describe(result.failure) + "\n", failure: result.failure };
  };

  return {
    root,
    cwd,
    env,
    gh: (args, deadline) => spawn(["gh", ...args], deadline),
    git: (args, deadline) => spawn(["git", ...args], deadline),
    clock: () => Math.floor(Date.now() / 1000),
    sleep: (seconds) => Bun.sleep(seconds * 1000),
  };
}

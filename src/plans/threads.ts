import { join } from "node:path";
import { readDeliveryConfig } from "../delivery.ts";
import { ghOutput } from "../gh.ts";
import { processIo, type Io } from "../io.ts";
import { detectProject, gitRead, readCheckout } from "../project.ts";
import { describe } from "../read.ts";
import { ownedKey } from "../stack/skills-base.ts";
import { indexIn, plansDir } from "./index-tsv.ts";
import { readPlans, type Plans } from "./projection.ts";
import {
  decide,
  factsBy,
  limit,
  message,
  readFactsArray,
  resumeEvery,
  stateFor,
  type FactsKey,
  type ThreadFacts,
} from "./resume.ts";
import { AD_HOC_ID, bookkeepingEvents, logDetail, type TrailEntry } from "./trail.ts";
import { appendLog } from "./commit.ts";
import { AD_HOC_EVENTS } from "./store.ts";

export const threadsResumeKey = "THREADS_RESUME_EVERY";

function indexedIn(branch: string, plans: Plans, env: NodeJS.ProcessEnv): string | undefined {
  const projects = [...plans.projects].sort(([left], [right]) => (left < right ? -1 : 1));
  for (const [project, rows] of projects)
    if (rows.some((row) => row.branch === branch))
      return `${branch} is in ${indexIn(join(plansDir(env), project))}, so its row keeps the trail`;

  return undefined;
}

export async function threadsLogVerb(
  args: readonly string[],
  usage: string,
  io: Io = processIo(),
): Promise<number> {
  const [branch, event, detail = ""] = args;
  if (!branch || !event || args.length > 3 || branch.startsWith("-")) {
    io.err(`usage: ${usage}\n`);
    return 2;
  }

  const refuse = (reason: string): number => {
    io.err(`threads log: ${reason}\n`);
    return 1;
  };

  if (!(AD_HOC_EVENTS as readonly string[]).includes(event))
    return refuse(`${event} is not one of ${AD_HOC_EVENTS.join(", ")}`);

  const read = await readPlans(io.env);
  if (read.kind === "failed") return refuse(read.reason);

  const indexed = indexedIn(branch, read.plans, io.env);
  if (indexed) return refuse(indexed);

  const mark = await readMark(branch, io);
  if (mark !== "marked") return refuse(mark === "unmarked" ? noMark(branch) : mark);

  const project = await trailProject(io);
  const line = detail ? `${branch} ${logDetail(detail)}` : branch;
  await appendLog(project, AD_HOC_ID, event, line, io.env, (whole) => whole);
  return 0;
}

function noMark(branch: string): string {
  return `${branch} carries no publish mark`;
}

async function readMark(branch: string, io: Io): Promise<"marked" | "unmarked" | string> {
  const key = ownedKey(branch);
  const mark = await gitRead(io.cwd, ["config", "--get", key], {}, io);
  if (!mark.ok) return `cannot read ${key} (${describe(mark.failure)})`;
  if (mark.code > 1) return `cannot read ${key} (git config exited ${mark.code})`;

  return mark.stdout.trim() === "true" ? "marked" : "unmarked";
}

export async function trailProject(io: Io): Promise<string> {
  return (
    (await detectProject(io.cwd, plansDir(io.env), true)) ??
    (await readCheckout(io.cwd, true, io)).candidates.at(-1)!
  );
}

function adHocTrail(project: string, trail: readonly TrailEntry[]): Map<string, TrailEntry[]> {
  const byBranch = new Map<string, TrailEntry[]>();
  for (const entry of trail) {
    if (entry.project !== project || entry.id !== AD_HOC_ID) continue;

    const [branch = "", ...rest] = entry.detail.split(" ");
    const entries = byBranch.get(branch) ?? [];
    entries.push({ ...entry, detail: rest.join(" ") });
    byBranch.set(branch, entries);
  }

  return byBranch;
}

async function openPr(branch: string, io: Io): Promise<{ url?: string } | string> {
  const output = await ghOutput(
    ["pr", "list", "--head", branch, "--state", "open", "--json", "url,isCrossRepository"],
    io,
  );

  if (output === undefined) return `gh pr list failed for ${branch}`;

  try {
    const value: unknown = JSON.parse(output);
    if (!Array.isArray(value)) throw new Error("PR list is not an array");

    const pr = (value as Record<string, unknown>[]).find(
      (pr) => pr.isCrossRepository === false && typeof pr.url === "string",
    );

    return pr ? { url: pr.url as string } : {};
  } catch (error) {
    return `gh pr list for ${branch}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const branchKey: FactsKey = {
  field: "branch",
  valid: (value) => /^[^\s-]\S*$/.test(value),
  invalid: "branch is not a branch name",
};

export async function threadsResumeVerb(
  args: readonly string[],
  usage: string,
  io: Io = processIo(),
  readFacts: () => Promise<string> = () => Bun.stdin.text(),
): Promise<number> {
  if (args.some((arg) => arg !== "--facts")) {
    io.err(`usage: ${usage}\n`);
    return 2;
  }

  const refuse = (reason: string): number => {
    io.err(`threads resume: ${reason}\n`);
    return 1;
  };

  const every = resumeEvery(readDeliveryConfig(io.env), threadsResumeKey);
  if (every.note) io.err(`threads resume: ${every.note}\n`);
  if (every.minutes === undefined) {
    io.out("off\n");
    return 0;
  }

  let facts: Map<string, ThreadFacts | undefined> | undefined;
  if (args.includes("--facts")) {
    const parsed = await readFactsArray(readFacts);
    if (typeof parsed === "string") return refuse(parsed);
    facts = factsBy(parsed, branchKey, "threads resume", io);
  }

  const read = await readPlans(io.env);
  if (read.kind === "failed") return refuse(read.reason);

  const trail = adHocTrail(await trailProject(io), read.plans.trail);

  const ignored: readonly string[] = bookkeepingEvents;
  const lastEvent = (branch: string) =>
    trail.get(branch)?.findLast((entry) => !ignored.includes(entry.event))?.event;

  const now = new Date();
  const nudged = new Map<string, string>();
  let failed = false;
  io.out(`every ${every.minutes}m\n`);

  for (const branch of trail.keys()) {
    const listed = facts?.has(branch) ?? false;
    if (lastEvent(branch) !== "start" && !listed) continue;

    const mark = await readMark(branch, io);
    if (mark === "unmarked" && !listed) continue;

    const indexed = mark === "marked" ? indexedIn(branch, read.plans, io.env) : undefined;
    const owner = mark === "marked" ? indexed : mark === "unmarked" ? noMark(branch) : mark;

    const pr = owner === undefined ? await openPr(branch, io) : {};
    const unread = mark !== "marked" && mark !== "unmarked";
    if (unread || typeof pr === "string") failed = true;

    const url = typeof pr === "string" ? undefined : pr.url;
    const reason = owner ?? (typeof pr === "string" ? pr : url ? undefined : "no open PR");
    if (!facts) {
      io.out(reason ? `skip ${branch} ${reason}\n` : `read ${branch} ${url}\n`);
      continue;
    }

    const thread = facts.get(branch);
    if (!thread) {
      io.out(`skip ${branch} ${facts.has(branch) ? "bad facts" : (reason ?? "no thread")}\n`);
      continue;
    }

    const state = stateFor(reason, thread, lastEvent(branch), now);
    const runId = thread.run?.runId ?? "";
    const earlier = nudged.get(thread.thread);
    const decision = earlier
      ? { kind: "skip" as const, reason: `nudged through ${earlier}` }
      : limit(decide(state), trail.get(branch) ?? [], runId, now);

    if (decision.kind === "nudge") nudged.set(thread.thread, branch);
    io.out(
      decision.kind === "skip"
        ? `skip ${branch} ${decision.reason}\n`
        : `nudge ${branch} ${decision.cause} ${thread.thread} ${runId} ${message(`the PR on ${branch}`, decision.cause, state)}\n`,
    );
  }

  return failed ? 1 : 0;
}

import { statSync } from "node:fs";
import { lines, readDeliveryConfig, type DeliveryConfig } from "../delivery.ts";
import { processIo, type Io } from "../io.ts";
import { checkoutIs, gitOutput } from "../project.ts";
import { indexPath, missingIndex, readIndex, type IndexRow } from "./index-tsv.ts";
import { bookkeepingEvents, readTrail, trailPath, type TrailEntry } from "./trail.ts";

export const resumeKey = "PLANS_RESUME_EVERY";
export const idleMinutesBeforeUnknown = 20;
export const minutesBetweenNudges = 60;
export const minutesBackgroundWorkCounts = 120;
export const unknownNudgesWithoutProgress = 3;

export type Cause = "rate-limit" | "restart" | "unknown";
export type Ending =
  | { kind: "rate-limit"; resetAt?: Date }
  | { kind: "restart" }
  | { kind: "stopped" }
  | { kind: "other" };

export type State = {
  status: string;
  lastEvent: string | undefined;
  running: boolean;
  question: boolean;
  idleMinutes: number;
  ending: Ending;
  now: Date;
};

export type Decision = { kind: "skip"; reason: string } | { kind: "nudge"; cause: Cause };
type Rule = readonly [when: (state: State) => boolean, then: (state: State) => Decision];

export type Item = {
  runId: string;
  type: string;
  status: string;
  title: string | null;
  text: string;
};

export type ThreadFacts = {
  id: string;
  thread: string;
  status: string;
  pendingRequestCount: number;
  run: { runId: string; status: string; completedAt: string | null } | null;
  items: Item[];
  asks: boolean;
  waits: boolean;
  resetAt?: string;
};

const liveStatuses = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const stoppedStatuses = new Set(["interrupted", "cancelled"]);
const unfinishedItems = new Set(["pending", "running", "waiting"]);
const workItems = new Set(["command_execution", "dynamic_tool", "subagent"]);
const passiveItems = new Set(["assistant_message", "reasoning", "error", "checkpoint"]);

const usageLimit = /usage limit|rate.?limit|\b429\b|cooling down/i;
const restartNotice = /T3 (Code|server) restarted/i;

function skip(reason: string): Decision {
  return { kind: "skip", reason };
}

function nudge(cause: Cause): Decision {
  return { kind: "nudge", cause };
}

function afterReset(state: State): Decision {
  const resetAt = state.ending.kind === "rate-limit" ? state.ending.resetAt : undefined;
  return resetAt && resetAt > state.now
    ? skip(`rate limit resets ${resetAt.toISOString()}`)
    : nudge("rate-limit");
}

export const table: readonly Rule[] = [
  [(state) => state.status !== "DOING", () => skip("not DOING")],
  [(state) => state.running, () => skip("running")],
  [(state) => state.question, () => skip("open question")],
  [(state) => state.lastEvent === "handback", () => skip("handed back")],
  [(state) => state.ending.kind === "stopped", () => skip("stopped or cancelled")],
  [(state) => state.ending.kind === "rate-limit", afterReset],
  [(state) => state.ending.kind === "restart", () => nudge("restart")],
  [(state) => state.idleMinutes >= idleMinutesBeforeUnknown, () => nudge("unknown")],
  [() => true, (state) => skip(`idle ${Math.floor(state.idleMinutes)} min`)],
];

export function decide(state: State): Decision {
  return table.find(([when]) => when(state))![1](state);
}

export function limit(
  decision: Decision,
  trail: readonly TrailEntry[],
  runId: string,
  now: Date,
): Decision {
  if (decision.kind !== "nudge") return decision;

  const nudges = trail
    .filter((entry) => entry.event === "nudge")
    .map((entry) => ({ at: new Date(entry.ts), run: entry.detail.split(" ")[1] ?? "" }));

  if (nudges.some((entry) => entry.run === runId)) return skip("nudged this stall");

  const events = trail.filter((entry) => entry.event !== "thread");
  const since = events.slice(events.findLastIndex((entry) => entry.event !== "nudge") + 1);
  const unknown = new Set(
    since.filter((entry) => entry.detail.startsWith("unknown ")).map((entry) => entry.detail),
  );

  if (decision.cause === "unknown" && unknown.size >= unknownNudgesWithoutProgress)
    return skip(`nudged ${unknown.size} times while idle with no other event`);

  const recent = nudges.findLast(
    (entry) => now.getTime() - entry.at.getTime() < minutesBetweenNudges * 60_000,
  );

  return recent ? skip(`nudged ${recent.at.toISOString()}`) : decision;
}

function restarted(thread: ThreadFacts): boolean {
  const items = thread.items.filter((item) => item.runId === thread.run?.runId);
  const notice = items.findLastIndex(
    (item) => restartNotice.test(item.text) && /cancelled/i.test(item.text),
  );

  return notice >= 0 && items.slice(notice + 1).every((item) => passiveItems.has(item.type));
}

export function ending(thread: ThreadFacts): Ending {
  const run = thread.run;
  if (!run) return { kind: "other" };
  if (stoppedStatuses.has(run.status)) return { kind: "stopped" };

  const items = thread.items.filter((item) => item.runId === run.runId);
  const last = items.findLast((item) => item.type !== "checkpoint" && item.type !== "reasoning");
  if (last?.type === "error" && usageLimit.test(`${last.title ?? ""} ${last.text}`))
    return thread.resetAt
      ? { kind: "rate-limit", resetAt: new Date(thread.resetAt) }
      : { kind: "rate-limit" };

  return restarted(thread) ? { kind: "restart" } : { kind: "other" };
}

export function running(thread: ThreadFacts, idleMinutes: number): boolean {
  if (liveStatuses.has(thread.status) || !thread.run || liveStatuses.has(thread.run.status))
    return true;

  if (restarted(thread) || idleMinutes >= minutesBackgroundWorkCounts) return false;

  return (
    thread.waits ||
    thread.items.some((item) => workItems.has(item.type) && unfinishedItems.has(item.status))
  );
}

export function stateFor(
  row: IndexRow,
  thread: ThreadFacts,
  lastEvent: string | undefined,
  now: Date,
): State {
  const completedAt = thread.run?.completedAt;
  const ended = completedAt ? Date.parse(completedAt) : now.getTime();
  const idleMinutes = Math.max(0, (now.getTime() - ended) / 60_000);
  return {
    status: row.status,
    lastEvent,
    running: running(thread, idleMinutes),
    question: thread.pendingRequestCount > 0 || thread.asks,
    idleMinutes,
    ending: ending(thread),
    now,
  };
}

export function message(id: string, cause: Cause, state: State): string {
  if (cause === "rate-limit")
    return `Your last turn stopped on a usage limit, which may have cleared by now. Carry on with plan ${id} from where you stopped.`;

  if (cause === "restart")
    return `The T3 server restarted and cancelled background work your last turn was waiting on, so it will not report back. Rerun what it cancelled, then carry on with plan ${id}.`;

  return `This thread has been idle ${Math.floor(state.idleMinutes)} minutes with no handback and no open question. Carry on with plan ${id} from where you stopped.`;
}

export function resumeEvery(config: DeliveryConfig): { minutes?: number; note?: string } {
  if (config.invalid)
    return { note: config.notes[0] ?? `${config.path}: invalid config, resume is off` };

  if (!config.path) return {};

  const values = lines(config.content)
    .filter((line) => line.startsWith(`${resumeKey}=`))
    .map((line) => line.slice(resumeKey.length + 1));

  if (values.length === 0) return {};
  if (values.length > 1) return { note: `${config.path}: ${resumeKey} is set more than once` };
  if (!/^[1-9][0-9]*m$/.test(values[0]!))
    return { note: `${config.path}: ${resumeKey}=${values[0]} is not <minutes>m` };

  return { minutes: Number(values[0]!.slice(0, -1)) };
}

function isText(value: unknown): value is string {
  return typeof value === "string";
}

function isWord(value: unknown): value is string {
  return isText(value) && /^\S+$/.test(value);
}

function isTime(value: unknown): value is string {
  return isText(value) && !Number.isNaN(Date.parse(value));
}

function parseItem(value: unknown): Item | undefined {
  if (typeof value !== "object" || value === null) return undefined;

  const item = value as Record<string, unknown>;
  const title = item.title ?? null;

  if (!isText(item.runId) || !isText(item.type) || !isText(item.status) || !isText(item.text))
    return undefined;

  if (title !== null && !isText(title)) return undefined;
  return { runId: item.runId, type: item.type, status: item.status, title, text: item.text };
}

function parseRun(value: unknown, status: string): ThreadFacts["run"] | string {
  if (value === null || value === undefined)
    return liveStatuses.has(status) ? null : "run is missing";

  if (typeof value !== "object") return "run is not an object";

  const run = value as Record<string, unknown>;
  const completedAt = run.completedAt ?? null;
  if (!isWord(run.runId) || !isText(run.status)) return "run needs runId and status";
  if (completedAt !== null && !isTime(completedAt)) return "run.completedAt is not a time";
  if (completedAt === null && !liveStatuses.has(run.status))
    return `run is ${run.status} with no completedAt`;

  return { runId: run.runId, status: run.status, completedAt };
}

export function parseFacts(value: unknown): ThreadFacts | string {
  if (typeof value !== "object" || value === null) return "not an object";

  const entry = value as Record<string, unknown>;
  if (!isText(entry.id) || !/^\d{3}$/.test(entry.id)) return "id is not a plan id";
  if (!isWord(entry.thread)) return "thread is not a thread id";
  if (!isText(entry.status)) return "status is missing";
  if (typeof entry.pendingRequestCount !== "number") return "pendingRequestCount is not a number";
  if (typeof entry.asks !== "boolean" || typeof entry.waits !== "boolean")
    return "asks and waits must be booleans";

  const run = parseRun(entry.run, entry.status);
  if (isText(run)) return run;
  if (entry.resetAt !== undefined && !isTime(entry.resetAt)) return "resetAt is not a time";
  if (!Array.isArray(entry.items)) return "items is not an array";

  const items = entry.items.map(parseItem);
  if (items.some((item) => item === undefined)) return "an item needs runId, type, status and text";

  return {
    id: entry.id,
    thread: entry.thread,
    status: entry.status,
    pendingRequestCount: entry.pendingRequestCount,
    run,
    items: items as Item[],
    asks: entry.asks,
    waits: entry.waits,
    ...(entry.resetAt === undefined ? {} : { resetAt: entry.resetAt }),
  };
}

function trailFor(project: string, env: NodeJS.ProcessEnv): Map<string, TrailEntry[]> {
  const byId = new Map<string, TrailEntry[]>();
  const log = trailPath(env);
  try {
    if (!statSync(log).isFile()) return byId;
  } catch {
    return byId;
  }

  for (const entry of readTrail(log)) {
    if (entry.project !== project) continue;

    const entries = byId.get(entry.id) ?? [];
    entries.push(entry);
    byId.set(entry.id, entries);
  }

  return byId;
}

export function binding(entries: readonly TrailEntry[]): string | undefined {
  const session = entries.findLastIndex(
    (entry) => entry.event === "start" || entry.event === "review",
  );

  return entries.slice(session + 1).findLast((entry) => entry.event === "thread")?.detail;
}

async function checkouts(cwd: string, io: Io): Promise<Map<string, string>> {
  const listing = await gitOutput(cwd, ["worktree", "list", "--porcelain"], { quiet: true }, io);
  const byBranch = new Map<string, string>();

  let path = "";
  for (const line of (listing ?? "").split("\n"))
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line.startsWith("branch refs/heads/"))
      byBranch.set(line.slice("branch refs/heads/".length), path);

  return byBranch;
}

function factsById(parsed: unknown[], io: Io): Map<string, ThreadFacts | undefined> {
  const facts = new Map<string, ThreadFacts | undefined>();
  for (const [position, value] of parsed.entries()) {
    const id = (value as { id?: unknown } | null)?.id;
    const label = isText(id) ? id : `entry ${position + 1}`;
    const entry = isText(id) && facts.has(id) ? "listed more than once" : parseFacts(value);
    if (isText(entry)) io.err(`resume: facts for ${label}: ${entry}\n`);
    if (isText(id)) facts.set(id, isText(entry) ? undefined : entry);
  }

  return facts;
}

export async function resumeVerb(
  args: readonly string[],
  usage: string,
  io: Io = processIo(),
  readFacts: () => Promise<string> = () => Bun.stdin.text(),
): Promise<number> {
  const positionals = args.filter((arg) => arg !== "--facts");
  if (positionals.length !== 1 || !positionals[0] || positionals[0].startsWith("-")) {
    io.err(`usage: ${usage}\n`);
    return 2;
  }

  const project = positionals[0];
  const refuse = (reason: string): number => {
    io.err(`resume: ${reason}\n`);
    return 1;
  };

  const mismatch = await checkoutIs(io.cwd, project, io);
  if (mismatch) return refuse(mismatch);

  const every = resumeEvery(readDeliveryConfig(io.env));
  if (every.note) io.err(`resume: ${every.note}\n`);
  if (every.minutes === undefined) {
    io.out("off\n");
    return 0;
  }

  let rows: IndexRow[];
  try {
    rows = readIndex(indexPath(project, io.env));
  } catch {
    return refuse(missingIndex(project));
  }

  const trail = trailFor(project, io.env);
  const ignored: readonly string[] = bookkeepingEvents;
  const lastEvent = (id: string) =>
    trail.get(id)?.findLast((entry) => !ignored.includes(entry.event))?.event;

  if (!args.includes("--facts")) {
    const branches = await checkouts(io.cwd, io);
    io.out(`every ${every.minutes}m\n`);

    for (const row of rows.filter((row) => row.status === "DOING"))
      io.out(
        lastEvent(row.id) === "handback"
          ? `skip ${row.id} handed back\n`
          : `read ${row.id} ${binding(trail.get(row.id) ?? []) ?? "-"} ${branches.get(row.branch) ?? "-"}\n`,
      );

    return 0;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFacts());
  } catch (error) {
    return refuse(`facts are not JSON: ${String(error)}`);
  }

  if (!Array.isArray(parsed)) return refuse("facts are not a JSON array");

  const facts = factsById(parsed, io);
  const now = new Date();
  io.out(`every ${every.minutes}m\n`);

  for (const row of rows.filter((row) => row.status === "DOING" || facts.has(row.id))) {
    const thread = facts.get(row.id);
    if (!thread) {
      const reason = facts.has(row.id)
        ? "bad facts"
        : lastEvent(row.id) === "handback"
          ? "handed back"
          : "no thread";

      io.out(`skip ${row.id} ${reason}\n`);
      continue;
    }

    const state = stateFor(row, thread, lastEvent(row.id), now);
    const runId = thread.run?.runId ?? "";
    const decision = limit(decide(state), trail.get(row.id) ?? [], runId, now);
    io.out(
      decision.kind === "skip"
        ? `skip ${row.id} ${decision.reason}\n`
        : `nudge ${row.id} ${decision.cause} ${thread.thread} ${runId} ${message(row.id, decision.cause, state)}\n`,
    );
  }

  return 0;
}

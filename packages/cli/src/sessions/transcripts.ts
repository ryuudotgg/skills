import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  mergedEffort,
  secondStamp,
  UNKNOWN_EFFORT,
  USAGE_FIELDS,
  type Host,
  type SessionStats,
  type Usage,
  type UsageField,
} from "skills-core";
import { toolName } from "../audit/transcript.ts";
import { sha256 } from "../plans/store.ts";
import { childPath, directoryEntries, object, parseTimestamp, pathString } from "./jsonl.ts";
import type { RecordObject } from "./jsonl.ts";

const CHUNK = 4 * 1024 * 1024;

const NEWLINE = 0x0a;

const ROLLOUT = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/;

const RECENT_MESSAGES = 64;

const CODEX_TOTALS = {
  in: "input_tokens",
  out: "output_tokens",
  cached: "cached_input_tokens",
  reasoning: "reasoning_output_tokens",
  total: "total_tokens",
} as const satisfies Record<(typeof USAGE_FIELDS.codex)[number], string>;

type CodexField = keyof typeof CODEX_TOTALS;

export type Transcript = { path: string; host: Host; session: string; subagent: boolean };

export type Seen = { cwd: string | null; branch: string | null };

type Part = Omit<SessionStats, "host" | "session" | "subagents">;

type Carry =
  | { host: "claude"; messages: string[] }
  | { host: "codex"; model: string; effort: string; totals: Record<CodexField, number> };

type Recorded = { session: string | null; agent: string | null };

export type FileState = {
  carry: Carry;
  part: Part;
  seen: Seen;
  generation?: number;
  recorded?: Recorded;
};

export type Progress = Transcript & {
  offset: number;
  mtime: number;
  size: number;
  head: string;
  state: FileState;
};

export type ProgressRow = Omit<Progress, "state" | "subagent"> & {
  subagent: number;
  state: string;
};

function emptyPart(): Part {
  return { models: {}, tools: {}, records: 0, start: null, end: null };
}

export function freshState(host: Host): FileState {
  const carry: Carry =
    host === "codex"
      ? { host, model: "unknown", effort: UNKNOWN_EFFORT, totals: zeroTotals() }
      : { host: "claude", messages: [] };

  return {
    carry,
    part: emptyPart(),
    seen: { cwd: null, branch: null },
    recorded: { session: null, agent: null },
  };
}

function zeroTotals(): Record<CodexField, number> {
  return { in: 0, out: 0, cached: 0, reasoning: 0, total: 0 };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function put<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function addUsage(
  part: Part,
  model: string,
  effort: string,
  counts: Partial<Record<UsageField, number>>,
): void {
  const usage: Usage = own(part.models, model) ?? { effort };
  usage.effort = mergedEffort(usage.effort, effort);

  for (const [field, count] of Object.entries(counts) as [UsageField, number][])
    usage[field] = (usage[field] ?? 0) + count;

  put(part.models, model, usage);
}

function countTool(part: Part, block: RecordObject): void {
  const name = toolName(block);
  put(part.tools, name, (own(part.tools, name) ?? 0) + 1);
}

function stamp(part: Part, value: unknown): void {
  const micros = parseTimestamp(value);
  if (micros === null) return;

  const at = secondStamp(Math.floor(micros / 1000));
  if (part.start === null || Date.parse(at) < Date.parse(part.start)) part.start = at;
  if (part.end === null || Date.parse(at) > Date.parse(part.end)) part.end = at;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readClaude(record: RecordObject, state: FileState, carry: Carry & { host: "claude" }) {
  state.seen.cwd ??= text(record.cwd);
  state.seen.branch ??= text(record.gitBranch);

  const message = record.message;
  if (record.type !== "assistant" || !object(message)) return;

  if (Array.isArray(message.content))
    for (const block of message.content)
      if (object(block) && block.type === "tool_use") countTool(state.part, block);

  const model = text(message.model);
  const usage = message.usage;
  if (model === null || model === "<synthetic>" || !object(usage)) return;

  const id = text(message.id);
  if (id !== null) {
    if (carry.messages.includes(id)) return;
    carry.messages = [...carry.messages.slice(1 - RECENT_MESSAGES), id];
  }

  addUsage(state.part, model, text(record.effort) ?? UNKNOWN_EFFORT, {
    in: count(usage.input_tokens),
    out: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite: count(usage.cache_creation_input_tokens),
  });
}

function turnEffort(payload: RecordObject): string | null {
  const direct = text(payload.effort);
  if (direct !== null) return direct;

  const mode = payload.collaboration_mode;
  return object(mode) && object(mode.settings) ? text(mode.settings.reasoning_effort) : null;
}

function readCodex(record: RecordObject, state: FileState, carry: Carry & { host: "codex" }) {
  const payload = record.payload;
  if (!object(payload)) return;

  if (record.type === "session_meta") {
    state.seen.cwd ??= text(payload.cwd);
    if (object(payload.git)) state.seen.branch ??= text(payload.git.branch);
    return;
  }

  if (record.type === "turn_context") {
    carry.model = text(payload.model) ?? carry.model;
    carry.effort = turnEffort(payload) ?? carry.effort;
    state.seen.cwd ??= text(payload.cwd);
    return;
  }

  if (
    record.type === "response_item" &&
    (payload.type === "function_call" || payload.type === "custom_tool_call")
  ) {
    countTool(state.part, payload);
    return;
  }

  if (record.type !== "event_msg" || payload.type !== "token_count") return;

  const info = payload.info;
  const totals = object(info) ? info.total_token_usage : null;
  if (!object(totals)) return;

  const next = zeroTotals();
  for (const [field, key] of Object.entries(CODEX_TOTALS) as [CodexField, string][])
    next[field] = count(totals[key]);

  const restarted = next.total < carry.totals.total;
  const delta: Partial<Record<CodexField, number>> = {};
  for (const field of Object.keys(next) as CodexField[])
    delta[field] = restarted ? next[field] : next[field] - carry.totals[field];

  carry.totals = next;
  addUsage(state.part, carry.model, carry.effort, delta);
}

function note(recorded: Recorded, host: Host, record: RecordObject): void {
  if (host === "claude") {
    recorded.session ??= text(record.sessionId);
    recorded.agent ??= text(record.agentId);
    return;
  }

  if (record.type === "session_meta" && object(record.payload))
    recorded.session ??= text(record.payload.id);
}

export function readRecord(record: RecordObject, state: FileState): void {
  state.part.records++;
  stamp(state.part, record.timestamp);
  if (state.recorded) note(state.recorded, state.carry.host, record);

  const carry = state.carry;
  if (carry.host === "claude") readClaude(record, state, carry);
  else readCodex(record, state, carry);
}

function entries(path: string): string[] {
  try {
    return directoryEntries(path);
  } catch {
    return [];
  }
}

export type HostDirs = { claude: string; codex: string };

export function hostDirs(env: NodeJS.ProcessEnv): HostDirs {
  const home = env.HOME || homedir();
  const claude = env.CLAUDE_CONFIG_DIR || childPath(home, ".claude");
  const codex = env.CODEX_HOME || childPath(home, ".codex");
  return {
    claude: childPath(pathString(claude), "projects"),
    codex: childPath(pathString(codex), "sessions"),
  };
}

export function claudeTranscripts(root: string): Transcript[] {
  const found: Transcript[] = [];
  for (const folder of entries(root)) {
    const project = childPath(root, folder);
    for (const name of entries(project)) {
      if (name.endsWith(".jsonl")) {
        const session = name.slice(0, -".jsonl".length);
        found.push({ path: childPath(project, name), host: "claude", session, subagent: false });
        continue;
      }

      const subagents = join(project, name, "subagents");
      for (const agent of entries(subagents))
        if (agent.startsWith("agent-") && agent.endsWith(".jsonl"))
          found.push({
            path: childPath(subagents, agent),
            host: "claude",
            session: name,
            subagent: true,
          });
    }
  }

  return found;
}

export function codexTranscripts(root: string): Transcript[] {
  const found: Transcript[] = [];
  for (const year of entries(root))
    for (const month of entries(join(root, year)))
      for (const day of entries(join(root, year, month))) {
        const folder = join(root, year, month, day);
        for (const name of entries(folder)) {
          const session = ROLLOUT.exec(name)?.[1];
          if (session)
            found.push({ path: join(folder, name), host: "codex", session, subagent: false });
        }
      }

  return found;
}

export function* lines(path: string, from: number, until: number): Generator<[Buffer, number]> {
  const fd = openSync(path, "r");
  try {
    let pending = Buffer.alloc(0);
    let position = from;
    while (position < until) {
      const buffer = Buffer.alloc(Math.min(CHUNK, until - position));
      const read = readSync(fd, buffer, 0, buffer.length, position);
      if (read === 0) break;

      const start = position - pending.length;
      const data = Buffer.concat([pending, buffer.subarray(0, read)]);
      position += read;

      let lineStart = 0;
      for (let end = data.indexOf(NEWLINE); end !== -1; end = data.indexOf(NEWLINE, lineStart)) {
        yield [data.subarray(lineStart, end), start + end + 1];
        lineStart = end + 1;
      }

      pending = data.subarray(lineStart);
    }
  } finally {
    closeSync(fd);
  }
}

function firstLine(path: string, size: number): Buffer | null {
  for (const [line] of lines(path, 0, size)) return line;
  return null;
}

export function parsed(line: Buffer): RecordObject | null {
  try {
    const value: unknown = JSON.parse(line.toString("utf8"));
    return object(value) ? value : null;
  } catch {
    return null;
  }
}

function codexIdentity(transcript: Transcript, line: Buffer): Transcript {
  const record = parsed(line);
  const payload = record?.type === "session_meta" ? record.payload : null;
  if (!object(payload) || !object(payload.source)) return transcript;

  const parent = text(payload.session_id) ?? text(payload.parent_thread_id);
  return parent ? { ...transcript, session: parent, subagent: true } : transcript;
}

function identity(transcript: Transcript, recorded: Recorded): string | null {
  if (recorded.session === null) return null;

  const stem = basename(transcript.path, ".jsonl").replace(/^agent-/, "");
  const agent = transcript.host === "claude" && transcript.subagent ? (recorded.agent ?? stem) : "";
  return `${transcript.host}\t${recorded.session}\t${agent}`;
}

export function savedIdentity(file: Progress): string | null {
  if (file.state.recorded) return identity(file, file.state.recorded);
  const named = file.host === "claude" ? file.session : ROLLOUT.exec(basename(file.path))?.[1];
  return named ? identity(file, { session: named, agent: null }) : null;
}

export function recordedIdentity(transcript: Transcript): string | null {
  let size;
  try {
    size = statSync(transcript.path).size;
  } catch {
    return null;
  }

  const recorded: Recorded = { session: null, agent: null };
  const wantsAgent = transcript.host === "claude" && transcript.subagent;
  for (const [line] of lines(transcript.path, 0, size)) {
    const record = parsed(line);
    if (record) note(recorded, transcript.host, record);
    if (recorded.session !== null && (recorded.agent !== null || !wantsAgent)) break;
  }

  return identity(transcript, recorded);
}

export function advance(transcript: Transcript, known: Progress | undefined): Progress | undefined {
  let info;
  try {
    info = statSync(transcript.path);
  } catch {
    return undefined;
  }

  const mtime = Math.floor(info.mtimeMs);
  const size = info.size;
  const unchanged = known?.path === transcript.path && known.mtime === mtime && known.size === size;
  if (unchanged) return undefined;

  const line = firstLine(transcript.path, size);
  if (!line) return undefined;

  const head = sha256(line);
  const identity = transcript.host === "codex" ? codexIdentity(transcript, line) : transcript;
  const resume = known && known.head === head && known.offset <= size;
  const restarts = known === undefined ? 0 : (known.state.generation ?? 0) + 1;
  const state: FileState = resume
    ? known.state
    : { ...freshState(transcript.host), generation: restarts };

  let offset = resume ? known.offset : 0;
  for (const [text, end] of lines(transcript.path, offset, size)) {
    const record = parsed(text);
    if (record) readRecord(record, state);
    offset = end;
  }

  return { ...identity, offset, mtime, size, head, state };
}

function sorted<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => (left < right ? -1 : 1)),
  );
}

function earliest(left: string | null, right: string | null): string | null {
  if (left === null || right === null) return left ?? right;
  return Date.parse(right) < Date.parse(left) ? right : left;
}

function latest(left: string | null, right: string | null): string | null {
  if (left === null || right === null) return left ?? right;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

export function foldStats(host: Host, session: string, files: readonly Progress[]): SessionStats {
  const total = emptyPart();

  let subagents = 0;
  for (const file of files) {
    if (file.subagent) subagents++;

    const { part } = file.state;
    for (const [model, usage] of Object.entries(part.models)) {
      const { effort, ...counts } = usage;
      addUsage(total, model, effort, counts);
    }

    for (const [name, calls] of Object.entries(part.tools))
      put(total.tools, name, (own(total.tools, name) ?? 0) + calls);

    total.records += part.records;
    total.start = earliest(total.start, part.start);
    total.end = latest(total.end, part.end);
  }

  const models = Object.fromEntries(
    Object.entries(sorted(total.models)).map(([model, usage]) => [
      model,
      canonicalUsage(host, usage),
    ]),
  );

  return {
    host,
    session,
    models,
    tools: sorted(total.tools),
    records: total.records,
    start: total.start,
    end: total.end,
    subagents,
  };
}

function canonicalUsage(host: Host, usage: Usage): Usage {
  const counts = USAGE_FIELDS[host].map((field) => [field, usage[field] ?? 0]);
  return { effort: usage.effort, ...Object.fromEntries(counts) };
}

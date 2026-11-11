import { randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BLOB_MAX,
  policyAllows,
  TRANSCRIPT_EVENT,
  type Host,
  type SessionPolicy,
  type TranscriptRecord,
} from "skills-core";
import { newestFacts } from "../plans/machine.ts";
import type { Fetch } from "../plans/outbox.ts";
import { blobBytes, isDeleted, type Store } from "../plans/store.ts";
import { encodedName } from "./claude.ts";
import { childPath } from "./jsonl.ts";
import { SESSION_ID, sessionLines } from "./ledger.ts";
import { localLinks, sessionKey, sessionPolicies } from "./policy.ts";
import { codexTranscripts, hostDirs, type HostDirs } from "./transcripts.ts";

export type Recorded = {
  machine: string;
  project: string;
  at: number;
  record: TranscriptRecord;
};

export type Series = {
  host: Host;
  session: string;
  project: string;
  chunks: Map<number, TranscriptRecord>;
  at: number;
};

export type Move = { from: string; to: string };

export type Filter = { project?: string; since?: number };

type Restored = { parts: Uint8Array[]; missing?: number };

const NEWLINE = Buffer.from("\n");

const NAME = "\\p{L}\\p{N}\\p{M}_\\-";

const SHA256 = /^[0-9a-f]{64}$/u;

const LOCATOR = /^[0-9a-f]{32}$/u;

const LITERAL = /"(?:[^"\\]|\\.)*"/gu;

const KEY = /\s*:/uy;

export function pickSeries(events: readonly Recorded[], self: string): Series | undefined {
  const newest = events.at(-1);
  if (newest === undefined || events.some((event) => event.machine === self)) return undefined;

  const theirs = events.filter((event) => event.machine === newest.machine);
  const series = Math.max(...theirs.map((event) => event.record.series));
  const chunks = new Map<number, TranscriptRecord>();

  let project = newest.project;
  let at = newest.at;
  for (const event of theirs) {
    if (event.record.series !== series) continue;

    chunks.set(event.record.chunk, event.record);
    project = event.project;
    if (event.record.chunk === 0) at = event.at;
  }

  return { host: newest.record.host, session: newest.record.session, project, chunks, at };
}

function recordedSeries(store: Store): Series[] {
  const rows = store.db
    .query(
      `SELECT machine, project, wall, payload FROM events
       WHERE type = ? AND legacy = 0 AND quarantined IS NULL ORDER BY wall, counter, machine`,
    )
    .all(TRANSCRIPT_EVENT) as { machine: string; project: string; wall: number; payload: string }[];

  const grouped = new Map<string, Recorded[]>();
  for (const row of rows) {
    const record = JSON.parse(row.payload) as TranscriptRecord;
    const key = sessionKey(record.host, record.session);
    const events = grouped.get(key) ?? [];
    events.push({ machine: row.machine, project: row.project, at: row.wall, record });
    grouped.set(key, events);
  }

  return [...grouped.values()]
    .flatMap((events) => pickSeries(events, store.machine) ?? [])
    .sort((left, right) =>
      left.host === right.host
        ? left.session.localeCompare(right.session)
        : left.host.localeCompare(right.host),
    );
}

const SHARED: readonly unknown[] = ["redacted", "full"];
function allows(policy: SessionPolicy | undefined, record: TranscriptRecord): boolean {
  return SHARED.includes(record.policy) && policyAllows(policy ?? "off", record.policy);
}

function wellFormed(record: TranscriptRecord): boolean {
  const { sha256, blob, bytes } = record;
  return (
    SHA256.test(String(sha256)) &&
    LOCATOR.test(String(blob)) &&
    Number.isInteger(bytes) &&
    bytes >= 0 &&
    bytes <= BLOB_MAX
  );
}

export function missingChunks(store: Store, root: string): Fetch[] {
  const policies = sessionPolicies(store, localLinks(root));
  const tombstoned = new Set(
    (
      store.db
        .query(
          "SELECT json_extract(payload, '$.blob') AS blob FROM events WHERE type = 'blob-deleted' AND quarantined IS NULL",
        )
        .all() as { blob: string }[]
    ).map((row) => row.blob),
  );

  const rows = store.db
    .query(
      `SELECT t.id, t.payload FROM events t
       WHERE t.type = ? AND t.legacy = 0 AND t.quarantined IS NULL AND t.withheld IS NULL
         AND NOT EXISTS (SELECT 1 FROM blobs b WHERE b.sha256 = json_extract(t.payload, '$.sha256'))
       ORDER BY t.wall, t.counter`,
    )
    .all(TRANSCRIPT_EVENT) as { id: string; payload: string }[];

  const found = new Map<string, Fetch>();
  for (const row of rows) {
    const record = JSON.parse(row.payload) as TranscriptRecord;
    const policy = policies.get(sessionKey(record.host, record.session));
    if (!wellFormed(record) || !allows(policy, record) || found.has(record.sha256)) continue;
    if (tombstoned.has(record.blob)) continue;

    found.set(record.sha256, { sha256: record.sha256, locator: record.blob, event: row.id });
  }

  return [...found.values()];
}

export function restoredParts(store: Store, series: Series, policy?: SessionPolicy): Restored {
  const last = Math.max(...series.chunks.keys());
  const parts: Uint8Array[] = [];

  let previous: TranscriptRecord | undefined;
  for (let chunk = 0; chunk <= last; chunk++) {
    const record = series.chunks.get(chunk);
    const usable =
      record !== undefined &&
      allows(policy, record) &&
      (previous === undefined || record.first === previous.last + 1) &&
      !isDeleted(store.db, record.blob);

    const bytes = usable ? blobBytes(store.db, record.sha256) : undefined;
    if (bytes === undefined) return { parts, missing: chunk };

    parts.push(bytes);
    previous = record;
  }

  return { parts };
}

function usable(path: string | undefined): path is string {
  return typeof path === "string" && path.startsWith("/") && path !== "/";
}

export function movesOf(record: TranscriptRecord | undefined, root: string, home: string): Move[] {
  const moves: Move[] = [];
  const cwd = usable(record?.cwd) ? record.cwd : undefined;
  const recordedRoot = usable(record?.root) ? record.root : undefined;
  const recordedHome = usable(record?.home) ? record.home : undefined;

  if (cwd && recordedRoot && cwd.startsWith(`${recordedRoot}/`))
    moves.push({ from: cwd, to: root + cwd.slice(recordedRoot.length) });
  else if (cwd) moves.push({ from: cwd, to: root });

  if (recordedRoot && recordedRoot !== cwd) moves.push({ from: recordedRoot, to: root });
  if (recordedHome && usable(home) && !moves.some((move) => move.from === recordedHome))
    moves.push({ from: recordedHome, to: home });

  return moves.sort((left, right) => right.from.length - left.from.length);
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function parses(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

export function rewriter(moves: readonly Move[]): (line: string) => string {
  if (moves.length === 0) return (line) => line;

  const targets = new Map(moves.map((move) => [move.from, move.to]));
  const pattern = new RegExp(
    `(?<![${NAME}.])(?:${moves.map((move) => escaped(move.from)).join("|")})(?![${NAME}]|\\.[${NAME}])`,
    "gu",
  );

  const needles = moves.flatMap((move) => [move.from, JSON.stringify(move.from).slice(1, -1)]);
  const text = (value: string): string => value.replace(pattern, (from) => targets.get(from)!);

  const json = (line: string): string => {
    const pieces: string[] = [];

    let copied = 0;
    for (const match of line.matchAll(LITERAL)) {
      const end = match.index + match[0].length;
      KEY.lastIndex = end;
      if (KEY.test(line)) continue;

      const value = JSON.parse(match[0]) as string;
      const moved = text(value);
      if (moved === value) continue;

      pieces.push(line.slice(copied, match.index), JSON.stringify(moved));
      copied = end;
    }

    return pieces.length === 0 ? line : pieces.join("") + line.slice(copied);
  };

  return (line) => {
    const escapes = line.includes("\\/") || line.includes("\\u");
    if (!escapes && !needles.some((needle) => line.includes(needle))) return line;

    const body = line.endsWith("\r") ? line.slice(0, -1) : line;
    return parses(body) ? json(body) + line.slice(body.length) : text(line);
  };
}

export function rewritten(parts: readonly Uint8Array[], rewrite: (line: string) => string): Buffer {
  const whole = Buffer.concat(parts);
  const out: Buffer[] = [];
  for (let start = 0; start < whole.length;) {
    const newline = whole.indexOf(0x0a, start);
    const end = newline < 0 ? whole.length : newline;
    const raw = whole.subarray(start, end);

    const decoded = raw.toString("utf8");
    const moved = rewrite(decoded);
    out.push(moved === decoded ? raw : Buffer.from(moved));
    if (newline >= 0) out.push(NEWLINE);

    start = end + 1;
  }

  return Buffer.concat(out);
}

export function targetOf(
  host: Host,
  session: string,
  root: string,
  start: number,
  dirs: HostDirs,
): string | undefined {
  if (!SESSION_ID.test(session) || session.startsWith("-")) return undefined;

  if (host === "claude")
    return childPath(childPath(dirs.claude, encodedName(root)), `${session}.jsonl`);

  if (host !== "codex" || Number.isNaN(start)) return undefined;

  const stamp = new Date(start).toISOString().slice(0, 19);
  const [year, month, day] = stamp.slice(0, 10).split("-") as [string, string, string];
  const name = `rollout-${stamp.replaceAll(":", "-")}-${session}.jsonl`;
  return childPath(childPath(childPath(childPath(dirs.codex, year), month), day), name);
}

export function writeExclusive(target: string, bytes: Uint8Array): boolean {
  mkdirSync(dirname(target), { recursive: true });

  const temporary = join(
    dirname(target),
    `.${randomBytes(6).toString("hex")}.${process.pid}.restore.tmp`,
  );

  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    linkSync(temporary, target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}

function attempt(write: () => boolean): boolean | string {
  try {
    return write();
  } catch (error) {
    const { code, message } = error as NodeJS.ErrnoException;
    return code ?? message;
  }
}

function shellWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

export function resumeLine(host: Host, session: string, root: string): string {
  const id = shellWord(session);
  return host === "claude"
    ? `cd ${shellWord(root)} && claude --resume ${id}`
    : `codex resume ${id}`;
}

export function restoreAll(store: Store, env: NodeJS.ProcessEnv, filter: Filter): string[] {
  const checkouts = newestFacts(store)?.checkouts ?? {};
  const starts = new Map(
    sessionLines(store).map((line) => [
      sessionKey(line.host, line.session),
      Date.parse(line.start),
    ]),
  );

  const policies = sessionPolicies(store, localLinks(dirname(store.db.filename)));
  const dirs = hostDirs(env);
  const codex = new Set(codexTranscripts(dirs.codex).map((transcript) => transcript.session));
  const home = env.HOME ?? "";

  const lines: string[] = [];
  let restored = 0;
  let skipped = 0;

  for (const series of recordedSeries(store)) {
    const { host, session, project } = series;
    const policy = policies.get(sessionKey(host, session));
    if (filter.project !== undefined && project !== filter.project) continue;
    if (!policyAllows(policy ?? "off", "redacted")) continue;

    const recorded = starts.get(sessionKey(host, session));
    const start = recorded === undefined || Number.isNaN(recorded) ? series.at : recorded;
    if (filter.since !== undefined && !(start >= filter.since)) continue;

    const skip = (reason: string) => {
      lines.push(`skipped ${host} ${session} ${reason}`);
      skipped++;
    };

    const root = checkouts[project]?.path;
    if (root === undefined) {
      skip(`no checkout for ${project}`);
      continue;
    }

    const target = targetOf(host, session, root, start, dirs);
    if (target === undefined) continue;

    if (existsSync(target) || (host === "codex" && codex.has(session))) {
      skip("exists");
      continue;
    }

    const { parts, missing } = restoredParts(store, series, policy);
    if (parts.length === 0) {
      skip("chunk 0 missing");
      continue;
    }

    const rewrite = rewriter(movesOf(series.chunks.get(0), root, home));
    const written = attempt(() => writeExclusive(target, rewritten(parts, rewrite)));
    if (written !== true) {
      skip(written === false ? "exists" : written);
      continue;
    }

    const gap =
      missing === undefined ? "" : ` through chunk ${missing - 1}, chunk ${missing} missing`;

    lines.push(`wrote ${host} ${session} ${target}${gap}`, resumeLine(host, session, root));
    restored++;
  }

  lines.push(`restored ${restored}, skipped ${skipped}`);
  return lines;
}

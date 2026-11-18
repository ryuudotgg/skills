import { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readSync as readBytes, statSync } from "node:fs";
import { join } from "node:path";
import {
  BLOB_MAX,
  policyAllows,
  CHUNK_SIZE,
  SESSION_EVENT,
  TRANSCRIPT_EVENT,
  type Host,
  type SessionPolicy,
  type TranscriptRecord,
} from "skills-core";
import { appendEvent, locatorOf, sha256, write, type Store } from "../plans/store.ts";
import { readSync } from "../read.ts";
import { digestText, foldDigest, freshDigest, type Digest } from "./digest.ts";
import { RULES_SHA256 } from "./gitleaks.ts";
import { parseTimestamp } from "./jsonl.ts";
import {
  localLinks,
  policyChanges,
  SCAN_DB,
  sessionKey,
  sessionPolicy,
  sessionProjects,
  statsWindows,
  type Window,
} from "./policy.ts";
import { envSecrets, redact } from "./redact.ts";
import { lines, parsed, type FileState } from "./transcripts.ts";

export const IDLE_MS = 10 * 60 * 1000;

export type ChunkLimits = {
  readonly deadline: number;
  readonly bytes: number;
  readonly room?: () => number;
  readonly perChunk?: number;
  readonly chunks?: number;
};

export type Unfit = { readonly id: string; readonly size: number };

export type Chunked = { made: number; withheld: number; refused?: Unfit };

type Source = {
  key: string;
  host: Host;
  session: string;
  path: string;
  cwd: string | null;
  generation: number;
  listed: readonly string[];
  project: string;
  plan: string;
  projects: ReadonlySet<string>;
  policy: SessionPolicy;
  windows: readonly Window[];
};

type Cursor = {
  path: string;
  head: string;
  generation: number;
  series: number;
  chunk: number;
  line: number;
  offset: number;
  withheld: number;
  digest: Digest;
};

type CursorRow = Omit<Cursor, "digest"> & { digest: string };

type Origin = { cwd: string; root: string; home: string };

type Pending = { lines: Buffer[]; bytes: number; first: number };

type Hidden = { start: number; last: number; offset: number };

type Judged = [raw: Buffer, end: number, inside: boolean];

type End = {
  last: number;
  offset: number;
  origin: Origin | undefined;
  secrets: readonly string[];
};

const NEWLINE = Buffer.from("\n");

class Spent extends Error {}

type MainFile = {
  path: string;
  cwd: string | null;
  generation: number;
  listed: readonly string[];
};

export function mainFiles(root: string): Map<string, MainFile> {
  const found = new Map<string, MainFile>();
  const path = join(root, SCAN_DB);
  if (!existsSync(path)) return found;

  const db = new Database(path, { readonly: true });
  try {
    const scanned = db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'files'")
      .get();

    if (scanned === null) return found;

    const rows = db
      .query("SELECT path, host, session, state FROM files WHERE subagent = 0 ORDER BY path")
      .all() as { path: string; host: Host; session: string; state: string }[];

    for (const row of rows) {
      const key = sessionKey(row.host, row.session);
      const state = JSON.parse(row.state) as FileState;
      found.set(key, {
        path: row.path,
        cwd: state.seen.cwd,
        generation: state.generation ?? 0,
        listed: [...(found.get(key)?.listed ?? []), row.path],
      });
    }
  } finally {
    db.close();
  }

  return found;
}

function sources(store: Store, root: string): Source[] {
  const linked = sessionProjects(store, localLinks(root));
  const changes = policyChanges(store);
  const policies = new Map(changes.map((change) => [change.project, change.policy]));
  const files = mainFiles(root);
  const rows = store.db
    .query(
      `SELECT project, plan, payload FROM events
       WHERE type = ? AND legacy = 0 AND quarantined IS NULL ORDER BY wall, counter, machine, id`,
    )
    .all(SESSION_EVENT) as { project: string; plan: string; payload: string }[];

  const latest = new Map<string, Pick<Source, "key" | "host" | "session" | "project" | "plan">>();
  for (const row of rows) {
    const { host, session } = JSON.parse(row.payload) as { host: Host; session: string };
    const key = sessionKey(host, session);
    latest.set(key, { key, host, session, project: row.project, plan: row.plan });
  }

  const tracked = new Set(
    (store.db.query("SELECT key FROM transcript_cursors").all() as { key: string }[]).map(
      (row) => row.key,
    ),
  );

  return [...latest.values()].flatMap((known) => {
    const file = files.get(known.key);
    const projects = linked.get(known.key) ?? new Set<string>();
    const policy = sessionPolicy(policies, projects);
    const read = policy !== "off" || tracked.has(known.key);
    if (file === undefined || !read) return [];

    return [{ ...known, ...file, projects, policy, windows: statsWindows(changes, projects) }];
  });
}

// Restore reads a series from chunk 0, so lines withheld before its first upload leave 0 free.
function afterWithheld(chunk: number): number {
  return chunk === 0 ? 0 : chunk + 1;
}

function uploads(policy: SessionPolicy): boolean {
  return policyAllows(policy, "redacted");
}

function bounded(text: string): Buffer {
  const bytes = Buffer.from(text);
  if (bytes.length <= BLOB_MAX) return bytes;

  const marker = `\n[dropped ${bytes.length} bytes past the blob cap]\n`;
  return Buffer.from(bytes.subarray(0, BLOB_MAX - 1024).toString() + marker);
}

export function forgetDigests(store: Store, records: readonly { host: Host; session: string }[]) {
  for (const { host, session } of records)
    store.db.run("UPDATE transcript_cursors SET digest = ? WHERE key = ?", [
      JSON.stringify(freshDigest(host)),
      sessionKey(host, session),
    ]);
}

function cursorOf(store: Store, key: string): Cursor | undefined {
  const row = store.db
    .query(
      `SELECT path, head, generation, series, chunk, line, offset, withheld, digest
       FROM transcript_cursors WHERE key = ?`,
    )
    .get(key) as CursorRow | null;

  return row === null ? undefined : { ...row, digest: JSON.parse(row.digest) as Digest };
}

function saveCursor(store: Store, key: string, cursor: Cursor): void {
  store.db.run(
    `INSERT INTO transcript_cursors
       (key, path, head, generation, series, chunk, line, offset, withheld, digest)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET path = excluded.path, head = excluded.head,
       generation = excluded.generation, series = excluded.series, chunk = excluded.chunk, line = excluded.line,
       offset = excluded.offset, withheld = excluded.withheld, digest = excluded.digest`,
    [
      key,
      cursor.path,
      cursor.head,
      cursor.generation,
      cursor.series,
      cursor.chunk,
      cursor.line,
      cursor.offset,
      cursor.withheld,
      JSON.stringify(cursor.digest),
    ],
  );
}

function localBlob(store: Store, digest: string, bytes: Uint8Array): string {
  const locator = locatorOf(store, digest);
  store.db.run("INSERT OR IGNORE INTO blobs (sha256, locator, bytes) VALUES (?, ?, ?)", [
    digest,
    locator,
    bytes,
  ]);

  return locator;
}

const HEAD_BLOCK = 64 * 1024;
function firstLine(path: string, size: number): Buffer | undefined {
  const head = Buffer.alloc(Math.min(HEAD_BLOCK, size));
  const fd = openSync(path, "r");
  try {
    const read = readBytes(fd, head, 0, head.length, 0);
    const end = head.subarray(0, read).indexOf(NEWLINE);
    if (end !== -1) return Buffer.from(head.subarray(0, end));
  } finally {
    closeSync(fd);
  }

  for (const [line] of lines(path, 0, size)) return line;
  return undefined;
}

function resumable(known: Cursor | undefined, source: Source, size: number): known is Cursor {
  if (known === undefined) return false;
  // The scan keeps no link from a moved file to its successor, so only a session's sole file can be one.
  const followed = known.path === source.path || source.listed.length === 1;
  return followed && known.generation === source.generation && known.offset <= size;
}

function cursorFor(
  store: Store,
  source: Source,
  head: string,
  size: number,
): { cursor: Cursor; moved: boolean } {
  const known = cursorOf(store, source.key);
  if (resumable(known, source, size) && known.head === head) {
    const moved = known.path !== source.path;
    return { cursor: { ...known, path: source.path }, moved };
  }

  const cursor = {
    path: source.path,
    head,
    generation: source.generation,
    series: known === undefined ? 0 : known.series + 1,
    chunk: 0,
    line: 0,
    offset: 0,
    withheld: known?.withheld ?? 0,
    digest: freshDigest(source.host),
  };

  return { cursor, moved: false };
}

const UNKNOWN = Number.NEGATIVE_INFINITY;
function recordedTime(raw: Buffer): number | undefined {
  if (raw.length >= BLOB_MAX) return UNKNOWN;
  return parseTimestamp(parsed(raw)?.timestamp) ?? undefined;
}

function* linesBefore(
  path: string,
  offset: number,
  floor: number,
  until: number,
): Generator<Buffer> {
  const fd = openSync(path, "r");
  try {
    let tail: Buffer[] = [];
    for (let at = offset - 1; at > floor;) {
      if (Date.now() > until) throw new Spent();

      const start = Math.max(floor, at - HEAD_BLOCK);
      const block = Buffer.alloc(at - start);
      readBytes(fd, block, 0, block.length, start);

      let stop = block.length;
      while (stop > 0) {
        const cut = block.lastIndexOf(NEWLINE, stop - 1);
        if (cut === -1) break;

        yield Buffer.concat([block.subarray(cut + 1, stop), ...tail]);
        tail = [];
        stop = cut;
      }

      tail.unshift(block.subarray(0, stop));
      at = start;
    }

    if (offset > 0 && floor === 0) yield Buffer.concat(tail);
  } finally {
    closeSync(fd);
  }
}

function timeBefore(path: string, offset: number, until: number): number {
  const floor = Math.max(0, offset - BLOB_MAX);
  for (const line of linesBefore(path, offset, floor, until)) {
    const time = recordedTime(line);
    if (time !== undefined) return time;
  }

  return UNKNOWN;
}

function* unjudged(path: string, from: number, size: number): Generator<Judged> {
  for (const [raw, end] of lines(path, from, size)) yield [raw, end, false];
}

type Reach = { from: number; size: number; until: number; mtime: number };

function* judged(source: Source, reach: Reach): Generator<Judged> {
  const overlaps = (from: number, to: number) =>
    from === UNKNOWN ||
    source.windows.some((window) => window.from * 1000 <= to && from <= window.to * 1000);

  let last: number | undefined;
  let waiting: [Buffer, number][] = [];
  let held = 0;
  for (const [raw, end] of lines(source.path, reach.from, reach.size)) {
    const time = recordedTime(raw);
    if (time === undefined || time === UNKNOWN) {
      if (time === UNKNOWN) last = UNKNOWN;
      waiting.push([raw, end]);
      held += raw.length + 1;
      if (held < CHUNK_SIZE) continue;

      for (const [line, at] of waiting) yield [line, at, true];
      waiting = [];
      held = 0;
      continue;
    }

    last ??= waiting.length ? timeBefore(source.path, reach.from, reach.until) : time;
    const span = overlaps(Math.min(last, time), Math.max(last, time));
    for (const [line, at] of waiting) yield [line, at, span];

    waiting = [];
    held = 0;
    last = time;
    yield [raw, end, overlaps(time, time)];
  }

  if (!waiting.length) return;

  last ??= timeBefore(source.path, reach.from, reach.until);
  const span = overlaps(last, Math.max(last, reach.mtime));
  for (const [line, at] of waiting) yield [line, at, span];
}

function headOf(path: string, size: number, until: number): string | undefined {
  const hasher = new Bun.CryptoHasher("sha256");
  const buffer = Buffer.alloc(HEAD_BLOCK);
  const fd = openSync(path, "r");
  try {
    for (let at = 0; at < size; at += buffer.length) {
      if (at > 0 && Date.now() > until) return undefined;

      const read = readBytes(fd, buffer, 0, Math.min(buffer.length, size - at), at);
      const block = buffer.subarray(0, read);
      const end = block.indexOf(NEWLINE);
      if (end !== -1) return hasher.update(block.subarray(0, end)).digest("hex");

      hasher.update(block);
    }

    return undefined;
  } finally {
    closeSync(fd);
  }
}

export function originOf(cwd: string | null, env: NodeJS.ProcessEnv): Origin | undefined {
  if (cwd === null) return undefined;

  const listed = existsSync(cwd)
    ? readSync(["git", "rev-parse", "--show-toplevel"], { cwd, env, deadline: 5_000 })
    : undefined;

  const root = listed?.ok && listed.code === 0 ? listed.stdout.trim() || cwd : cwd;
  return { cwd, root, home: env.HOME ?? "" };
}

class Chunker {
  made = 0;
  withheld = 0;
  refused: Unfit | undefined;

  #read = 0;
  #produced = 0;

  constructor(
    readonly store: Store,
    readonly env: NodeJS.ProcessEnv,
    readonly limits: ChunkLimits,
  ) {}

  spend(bytes: number): void {
    this.#read += bytes;
    if (Date.now() > this.limits.deadline) throw new Spent();
  }

  full(): void {
    const chunks = this.limits.chunks ?? Number.POSITIVE_INFINITY;
    const late = Date.now() > this.limits.deadline;
    if (late || this.#read >= this.limits.bytes || this.made >= chunks) throw new Spent();
  }

  run(source: Source): void {
    this.full();

    let info;
    try {
      info = statSync(source.path);
    } catch {
      return;
    }

    const head = firstLine(source.path, info.size);
    if (head === undefined) return;

    const { cursor, moved } = cursorFor(this.store, source, sha256(head), info.size);
    if (moved) write(this.store, () => saveCursor(this.store, source.key, cursor));
    if (cursor.offset >= info.size) return;

    const origin = originOf(source.cwd, this.env);
    const secrets = origin === undefined ? [] : envSecrets([origin.cwd, origin.root]);
    const upload = uploads(source.policy);
    const isIdle = () => Date.now() - info.mtimeMs >= IDLE_MS;
    const reach = {
      from: cursor.offset,
      size: info.size,
      until: this.limits.deadline,
      mtime: info.mtimeMs * 1000,
    };

    const read =
      upload && source.windows.length > 0
        ? judged(source, reach)
        : unjudged(source.path, cursor.offset, info.size);

    let pending: Pending | undefined;
    let hidden: Hidden | undefined;
    let line = cursor.line;
    let offset = cursor.offset;
    for (const [raw, end, inside] of read) {
      line++;

      if (inside) {
        this.spend(raw.length + 1);

        if (pending !== undefined)
          this.close(source, cursor, pending, { last: line - 1, offset, origin, secrets });

        pending = undefined;
        hidden = { start: hidden?.start ?? offset, last: line, offset: end };
        offset = end;
        if (hidden.offset - hidden.start < CHUNK_SIZE) continue;

        this.withhold(source, cursor, hidden.last, hidden.offset);
        hidden = undefined;
        continue;
      }

      if (hidden !== undefined) this.withhold(source, cursor, hidden.last, hidden.offset);
      hidden = undefined;

      if (raw.length + 1 > BLOB_MAX) {
        if (pending !== undefined)
          this.close(source, cursor, pending, { last: line - 1, offset, origin, secrets });

        pending = undefined;
        this.withhold(source, cursor, line, end);
        offset = end;
        continue;
      }

      this.spend(raw.length + 1);

      const text =
        source.policy === "redacted" && raw.length < BLOB_MAX
          ? Buffer.from(redact(raw.toString("utf8"), secrets))
          : raw;

      const size = text.length + 1;
      if (pending !== undefined && (size > BLOB_MAX || pending.bytes + size > CHUNK_SIZE)) {
        this.close(source, cursor, pending, { last: line - 1, offset, origin, secrets });
        pending = undefined;
      }

      if (size > BLOB_MAX) {
        this.withhold(source, cursor, line, end);
        offset = end;
        continue;
      }

      if (upload) {
        const record = parsed(raw);
        if (record !== null) foldDigest(cursor.digest, record, secrets);
      }

      pending ??= { lines: [], bytes: 0, first: line };
      pending.lines.push(text, NEWLINE);
      pending.bytes += size;
      offset = end;
      if (pending.bytes < CHUNK_SIZE) continue;

      this.close(source, cursor, pending, { last: line, offset, origin, secrets });
      pending = undefined;
    }

    if (hidden !== undefined) this.withhold(source, cursor, hidden.last, hidden.offset);

    if (pending !== undefined && (isIdle() || !upload))
      this.close(source, cursor, pending, { last: line, offset, origin, secrets });
  }

  withhold(source: Source, cursor: Cursor, line: number, offset: number): void {
    cursor.chunk = afterWithheld(cursor.chunk);
    cursor.line = line;
    cursor.offset = offset;
    cursor.withheld++;

    write(this.store, () => saveCursor(this.store, source.key, cursor));
    this.withheld++;
    this.full();
  }

  close(source: Source, cursor: Cursor, pending: Pending, end: End): void {
    if (!uploads(source.policy)) {
      this.withhold(source, cursor, end.last, end.offset);
      return;
    }

    const { chunk } = cursor;
    const bytes = Buffer.concat(pending.lines);
    const digest = bounded(digestText(cursor.digest, end.secrets));
    const size = bytes.length + digest.length;
    const produced = this.#produced + size + (this.limits.perChunk ?? 0);
    if (this.limits.room !== undefined && produced > this.limits.room()) {
      this.refused = { id: `${source.key}@${cursor.offset}`, size };
      throw new Spent();
    }

    this.#produced = produced;
    const chunkSha = sha256(bytes);
    const digestSha = sha256(digest);

    cursor.chunk++;
    cursor.line = end.last;
    cursor.offset = end.offset;

    write(this.store, () => {
      const record: TranscriptRecord = {
        host: source.host,
        session: source.session,
        series: cursor.series,
        chunk,
        first: pending.first,
        last: end.last,
        sha256: chunkSha,
        blob: localBlob(this.store, chunkSha, bytes),
        bytes: bytes.length,
        policy: source.policy,
        rules: RULES_SHA256,
        digest: digestSha,
        digestBlob: localBlob(this.store, digestSha, digest),
        ...(chunk === 0 && end.origin !== undefined ? end.origin : {}),
      };

      appendEvent(this.store, {
        kind: "stored",
        type: TRANSCRIPT_EVENT,
        at: Date.now(),
        project: source.project,
        plan: source.plan,
        payload: record,
      });

      saveCursor(this.store, source.key, cursor);
    });

    this.made++;
    this.full();
  }
}

export function chunkTranscripts(
  store: Store,
  root: string,
  env: NodeJS.ProcessEnv,
  limits: ChunkLimits,
): Chunked {
  const chunker = new Chunker(store, env, limits);
  try {
    for (const source of sources(store, root)) chunker.run(source);
  } catch (error) {
    if (!(error instanceof Spent)) throw error;
  }

  return { made: chunker.made, withheld: chunker.withheld, refused: chunker.refused };
}

export function passOver(
  store: Store,
  root: string,
  project: string,
  commit: (save: () => void) => void,
): void {
  for (const source of sources(store, root)) {
    if (!source.projects.has(project)) continue;

    let info;
    try {
      info = statSync(source.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }

    const head = firstLine(source.path, info.size);
    if (head === undefined) continue;

    const { cursor, moved } = cursorFor(store, source, sha256(head), info.size);
    const end = lineEnd(source.path, cursor.offset, info.size, Number.POSITIVE_INFINITY);
    if (end === cursor.offset) {
      if (moved) commit(() => saveCursor(store, source.key, cursor));
      continue;
    }

    let passed = 0;
    let reached = cursor.offset;
    for (const [, at] of lines(source.path, cursor.offset, end)) {
      passed++;
      reached = at;
    }

    const passedOver = {
      ...cursor,
      chunk: afterWithheld(cursor.chunk),
      line: cursor.line + passed,
      offset: reached,
      withheld: cursor.withheld + 1,
    };

    commit(() => saveCursor(store, source.key, passedOver));
  }
}

function lineEnd(path: string, from: number, size: number, until: number): number {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BLOCK);
    for (let end = size; end > from; end -= buffer.length) {
      if (end < size && Date.now() > until) return end;

      const start = Math.max(from, end - buffer.length);
      const read = readBytes(fd, buffer, 0, end - start, start);
      const at = buffer.subarray(0, read).lastIndexOf(NEWLINE);
      if (at !== -1) return start + at + 1;
    }

    return from;
  } finally {
    closeSync(fd);
  }
}

export function uncutBytes(store: Store, root: string, until = Number.POSITIVE_INFINITY): number {
  let total = 0;
  for (const source of sources(store, root)) {
    if (!uploads(source.policy)) continue;

    let info;
    try {
      info = statSync(source.path);
    } catch {
      continue;
    }

    const known = cursorOf(store, source.key);
    const resumes =
      resumable(known, source, info.size) &&
      (known.path === source.path || known.head === headOf(source.path, info.size, until));

    const offset = resumes ? known.offset : 0;
    const left = lineEnd(source.path, offset, info.size, until) - offset;
    const idle = Date.now() - info.mtimeMs >= IDLE_MS;
    if (idle || left >= CHUNK_SIZE) total += left;
  }

  return total;
}

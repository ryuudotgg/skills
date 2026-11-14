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
import { localLinks, SCAN_DB, sessionKey, sessionPolicies } from "./policy.ts";
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
  project: string;
  plan: string;
  policy: SessionPolicy;
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

type End = {
  last: number;
  offset: number;
  origin: Origin | undefined;
  secrets: readonly string[];
};

const NEWLINE = Buffer.from("\n");

class Spent extends Error {}

type MainFile = { path: string; cwd: string | null; generation: number };

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
      const state = JSON.parse(row.state) as FileState;
      found.set(sessionKey(row.host, row.session), {
        path: row.path,
        cwd: state.seen.cwd,
        generation: state.generation ?? 0,
      });
    }
  } finally {
    db.close();
  }

  return found;
}

function sources(store: Store, root: string): Source[] {
  const policies = sessionPolicies(store, localLinks(root));
  const files = mainFiles(root);
  const rows = store.db
    .query(
      `SELECT project, plan, payload FROM events
       WHERE type = ? AND legacy = 0 AND quarantined IS NULL ORDER BY wall, counter, machine, id`,
    )
    .all(SESSION_EVENT) as { project: string; plan: string; payload: string }[];

  const latest = new Map<string, Omit<Source, "path" | "cwd" | "generation" | "policy">>();
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
    const policy = policies.get(known.key) ?? "off";
    const read = policy !== "off" || tracked.has(known.key);
    return file && read ? [{ ...known, ...file, policy }] : [];
  });
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

    const cursor = this.cursorFor(source, sha256(head), info.size);
    if (cursor.offset >= info.size) return;

    const origin = originOf(source.cwd, this.env);
    const secrets = origin === undefined ? [] : envSecrets([origin.cwd, origin.root]);
    const upload = uploads(source.policy);

    let pending: Pending | undefined;
    let line = cursor.line;
    let offset = cursor.offset;
    for (const [raw, end] of lines(source.path, cursor.offset, info.size)) {
      line++;

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

    const idle = Date.now() - info.mtimeMs >= IDLE_MS;
    if (pending !== undefined && (idle || !upload))
      this.close(source, cursor, pending, { last: line, offset, origin, secrets });
  }

  cursorFor(source: Source, head: string, size: number): Cursor {
    const known = cursorOf(this.store, source.key);
    if (
      known !== undefined &&
      known.head === head &&
      known.path === source.path &&
      known.generation === source.generation &&
      known.offset <= size
    )
      return known;

    return {
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
  }

  withhold(source: Source, cursor: Cursor, line: number, offset: number): void {
    cursor.chunk++;
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
      known !== undefined &&
      known.path === source.path &&
      known.generation === source.generation &&
      known.offset <= info.size;

    const offset = resumes ? known.offset : 0;
    const left = lineEnd(source.path, offset, info.size, until) - offset;
    const idle = Date.now() - info.mtimeMs >= IDLE_MS;
    if (idle || left >= CHUNK_SIZE) total += left;
  }

  return total;
}

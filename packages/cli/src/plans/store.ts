import { Database, type SQLQueryBindings } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  eventFrom,
  foldRows,
  historyOf,
  recordOf,
  ROW_EVENTS,
  STORE_EVENTS,
  tick,
  trailOf,
  type Clock,
  type EventDraft,
  type EventRecord,
  type FeedEvent,
  type History,
  type IndexRow,
  type PlanEvent,
  type TrailEntry,
} from "skills-core";
import { plansDir } from "./index-tsv.ts";

export type Store = { db: Database; machine: string; clock: Clock };

const MIGRATIONS = [
  [
    "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    `CREATE TABLE events (
      seq INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      machine TEXT NOT NULL,
      wall INTEGER NOT NULL,
      counter INTEGER NOT NULL,
      ts TEXT NOT NULL,
      project TEXT NOT NULL,
      plan TEXT NOT NULL,
      type TEXT NOT NULL,
      legacy INTEGER NOT NULL,
      payload TEXT NOT NULL
    )`,
    "CREATE INDEX events_project ON events (project, type)",
    "CREATE INDEX events_clock ON events (wall, counter)",
    "CREATE TABLE views (path TEXT PRIMARY KEY)",
    `CREATE TABLE revisions (
      seq INTEGER PRIMARY KEY,
      project TEXT NOT NULL,
      path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      text BLOB NOT NULL,
      captured TEXT NOT NULL,
      machine TEXT NOT NULL
    )`,
    "CREATE INDEX revisions_path ON revisions (path, seq)",
  ],
  [
    "ALTER TABLE views ADD COLUMN current TEXT",
    "ALTER TABLE views ADD COLUMN pending INTEGER NOT NULL DEFAULT 0",
  ],
] as const;

export function storePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(plansDir(env), "plans.db");
}

type OpenOptions = { fresh?: boolean; busyMs?: number; drain?: boolean };

export function openStore(path: string, options: OpenOptions = {}): Store {
  const { fresh = false, busyMs = 10_000, drain = !fresh } = options;
  const db = new Database(path, { create: fresh, readwrite: true, strict: true });
  try {
    db.run(`PRAGMA busy_timeout = ${busyMs}`);
    if (!fresh) db.run("PRAGMA journal_mode = WAL");
    migrate(db);

    const store = { db, machine: machineId(db), clock: lastClock(db) };
    if (drain) drainSpool(store, dirname(path));

    return store;
  } catch (error) {
    db.close();
    throw error;
  }
}

function schemaVersion(db: Database): number {
  const { user_version: version } = db.query("PRAGMA user_version").get() as {
    user_version: number;
  };

  return version;
}

function migrate(db: Database): void {
  if (schemaVersion(db) === MIGRATIONS.length) return;

  db.transaction(() => {
    const version = schemaVersion(db);
    if (version > MIGRATIONS.length)
      throw new Error(`plans.db schema ${version} is newer than this release`);

    for (const statements of MIGRATIONS.slice(version))
      for (const statement of statements) db.run(statement);

    db.run(`PRAGMA user_version = ${MIGRATIONS.length}`);
  }).immediate();
}

function machineId(db: Database): string {
  const known = db.query("SELECT value FROM meta WHERE key = 'machine'").get() as {
    value: string;
  } | null;

  if (known) return known.value;

  db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('machine', ?)", [randomUUID()]);

  const { value } = db.query("SELECT value FROM meta WHERE key = 'machine'").get() as {
    value: string;
  };

  return value;
}

function lastClock(db: Database): Clock {
  const last = db
    .query("SELECT wall, counter FROM events ORDER BY wall DESC, counter DESC LIMIT 1")
    .get() as Clock | null;

  return last ?? { wall: 0, counter: 0 };
}

export function write<T>(store: Store, edit: () => T): T {
  return store.db
    .transaction(() => {
      store.clock = lastClock(store.db);
      return edit();
    })
    .immediate();
}

export function appendEvent(store: Store, event: EventDraft): void {
  store.clock = tick(store.clock, event.at);

  const { ts, project, plan, type, legacy, payload } = recordOf(event);
  store.db.run(
    `INSERT INTO events (id, machine, wall, counter, ts, project, plan, type, legacy, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Bun.randomUUIDv7("hex", store.clock.wall),
      store.machine,
      store.clock.wall,
      store.clock.counter,
      ts,
      project,
      plan,
      type,
      legacy ? 1 : 0,
      JSON.stringify(payload),
    ],
  );
}

const ROW_TYPES = ROW_EVENTS.map(() => "?").join(", ");

const NOT_TRAIL = [...ROW_EVENTS, ...STORE_EVENTS];

const NOT_TRAIL_TYPES = NOT_TRAIL.map(() => "?").join(", ");

const EVENT_COLUMNS = "machine, wall, counter, ts, project, plan, type, legacy, payload";

type EventRow = Omit<EventRecord, "legacy" | "payload"> & { legacy: number; payload: string };

function recordOfRow<Row extends EventRow>(
  row: Row,
): Omit<Row, "legacy" | "payload"> & EventRecord {
  return { ...row, legacy: row.legacy === 1, payload: JSON.parse(row.payload) };
}

function decode(event: EventRow): PlanEvent {
  return eventFrom(recordOfRow(event));
}

function readEvents(store: Store, where: string, params: SQLQueryBindings[]): PlanEvent[] {
  const events = store.db
    .query(`SELECT ${EVENT_COLUMNS} FROM events WHERE ${where} ORDER BY seq`)
    .all(...params) as EventRow[];

  return events.map(decode);
}

export type FeedPage = { kind: "events"; events: FeedEvent[] } | { kind: "unknown" };

export function openReadOnly(path: string): Database {
  const db = new Database(path, { readonly: true, strict: true });
  db.run("PRAGMA busy_timeout = 2000");

  const version = schemaVersion(db);
  if (version === MIGRATIONS.length) return db;

  db.close();
  throw new Error(
    `plans.db schema ${version}, this release reads ${MIGRATIONS.length}; run any skills plans verb to migrate it`,
  );
}

export function eventsAfter(db: Database, after: string | undefined): FeedPage {
  const cursor =
    after === undefined
      ? { seq: 0 }
      : db.query<{ seq: number }, [string]>("SELECT seq FROM events WHERE id = ?").get(after);

  if (!cursor) return { kind: "unknown" };

  const rows = db
    .query<EventRow & { id: string }, [number]>(
      `SELECT id, ${EVENT_COLUMNS} FROM events WHERE seq > ? ORDER BY seq`,
    )
    .all(cursor.seq);

  return { kind: "events", events: rows.map(recordOfRow) };
}

export function blobBytes(db: Database, sha256: string): Uint8Array | undefined {
  return (
    db
      .query<{ text: Uint8Array }, [string]>(
        "SELECT text FROM revisions WHERE sha256 = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(sha256)?.text ?? undefined
  );
}

export function projectedRows(store: Store): Map<string, Map<string, IndexRow>> {
  return foldRows(readEvents(store, `legacy = 0 AND type IN (${ROW_TYPES})`, [...ROW_EVENTS]));
}

export function projectRows(
  store: Store,
  project: string,
  until = Number.MAX_SAFE_INTEGER,
): IndexRow[] {
  const events = readEvents(
    store,
    `project = ? AND legacy = 0 AND type IN (${ROW_TYPES}) AND wall <= ?`,
    [project, ...ROW_EVENTS, until],
  );

  return [...(foldRows(events).get(project)?.values() ?? [])];
}

export function rowsUntil(store: Store, until: number): Map<string, IndexRow[]> {
  const events = readEvents(store, `legacy = 0 AND type IN (${ROW_TYPES}) AND wall <= ?`, [
    ...ROW_EVENTS,
    until,
  ]);

  return new Map(
    [...foldRows(events)].map(([project, rows]) => [project, [...rows.values()]] as const),
  );
}

export function projectSince(store: Store, project: string): number | undefined {
  const first = store.db
    .query(
      `SELECT min(wall) AS wall FROM events
       WHERE project = ? AND legacy = 0 AND type IN (${ROW_TYPES})`,
    )
    .get(project, ...ROW_EVENTS) as { wall: number | null };

  return first.wall ?? undefined;
}

export function lastTrailEvent(
  store: Store,
  project: string,
  plan: string,
  ignored: readonly string[] = [],
): { event: string; detail: string } | undefined {
  const newestFirst = store.db
    .query(
      `SELECT ${EVENT_COLUMNS} FROM events
       WHERE project = ? AND plan = ? AND (legacy = 1 OR type NOT IN (${NOT_TRAIL_TYPES}))
         AND type NOT IN (SELECT value FROM json_each(?))
       ORDER BY seq DESC`,
    )
    .iterate(project, plan, ...NOT_TRAIL, JSON.stringify(ignored)) as Iterable<EventRow>;

  for (const event of newestFirst) {
    const [entry] = trailOf([decode(event)]);
    if (entry) return { event: entry.event, detail: entry.detail };
  }

  return undefined;
}

export function trailEntries(store: Store): TrailEntry[] {
  return trailOf(readEvents(store, `legacy = 1 OR type NOT IN (${NOT_TRAIL_TYPES})`, NOT_TRAIL));
}

export function indexedProjects(store: Store): string[] {
  const views = store.db
    .query("SELECT path FROM views WHERE path LIKE '%/index.tsv' ORDER BY path")
    .all() as { path: string }[];

  return views.map((view) => view.path.slice(0, -"/index.tsv".length));
}

export function importedViews(store: Store): string[] {
  const views = store.db.query("SELECT path FROM views ORDER BY path").all() as { path: string }[];
  return views.map((view) => view.path);
}

export function recordView(store: Store, path: string): void {
  store.db.run("INSERT OR IGNORE INTO views (path) VALUES (?)", [path]);
}

export type ViewState = { current: string | null; pending: number };

export function sha256(bytes: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export function readView(store: Store, path: string): ViewState | undefined {
  const view = store.db
    .query("SELECT current, pending FROM views WHERE path = ?")
    .get(path) as ViewState | null;

  return view ?? undefined;
}

export function markPending(store: Store, path: string): void {
  store.db.run(
    "INSERT INTO views (path, pending) VALUES (?, 1) ON CONFLICT (path) DO UPDATE SET pending = 1",
    [path],
  );
}

export function publishedView(store: Store, path: string, current: string): void {
  store.db.run(
    `INSERT INTO views (path, current, pending) VALUES (?, ?, 0)
     ON CONFLICT (path) DO UPDATE SET current = excluded.current, pending = 0`,
    [path, current],
  );
}

export function pendingViews(store: Store): string[] {
  const views = store.db.query("SELECT path FROM views WHERE pending = 1 ORDER BY path").all() as {
    path: string;
  }[];

  return views.map((view) => view.path);
}

export function trailHistory(store: Store, project: string, plan: string): History {
  const events = readEvents(
    store,
    `project = ? AND plan = ? AND (legacy = 1 OR type NOT IN (${NOT_TRAIL_TYPES}))`,
    [project, plan, ...NOT_TRAIL],
  );

  return historyOf(trailOf(events));
}

export function latestRevision(store: Store, path: string): string | undefined {
  const revision = store.db
    .query("SELECT sha256 FROM revisions WHERE path = ? ORDER BY seq DESC LIMIT 1")
    .get(path) as { sha256: string } | null;

  return revision?.sha256;
}

export function latestRevisionText(store: Store, path: string): Uint8Array | undefined {
  const revision = store.db
    .query("SELECT text FROM revisions WHERE path = ? ORDER BY seq DESC LIMIT 1")
    .get(path) as { text: Uint8Array } | null;

  return revision?.text;
}

export function recordRevision(
  store: Store,
  project: string,
  path: string,
  text: Uint8Array,
  sha256: string,
  captured = new Date().toISOString(),
): void {
  store.db.run(
    "INSERT INTO revisions (project, path, sha256, text, captured, machine) VALUES (?, ?, ?, ?, ?, ?)",
    [project, path, sha256, text, captured, store.machine],
  );
}

export const PLAN_FILE = /^\d{3}-.*\.md$/;
export const CTX_FILE = /^ctx-.*\.md$/;

type Change = { project: string; path: string; digest: string };

export function readCopy(path: string): Uint8Array | undefined {
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
}

function isCopyKey(stored: string): boolean {
  const parts = stored.split(sep);
  const [project = "", folder = "", name = ""] = parts;
  if (!project || project.startsWith(".") || isAbsolute(stored)) return false;
  if (parts.length === 2) return PLAN_FILE.test(folder) || CTX_FILE.test(folder);

  return parts.length === 3 && folder === "done" && PLAN_FILE.test(name);
}

export function workingCopyKey(root: string, path: string): string | undefined {
  const stored = relative(root, path);
  return isCopyKey(stored) ? stored : undefined;
}

export function workingCopyChange(
  store: Store,
  root: string,
  path: string,
  bytes: Uint8Array,
): Change | undefined {
  const stored = workingCopyKey(root, path);
  if (stored === undefined) return undefined;

  const digest = sha256(bytes);
  if (latestRevision(store, stored) === digest) return undefined;

  return { project: stored.split(sep)[0] ?? "", path: stored, digest };
}

export function recordCopy(store: Store, root: string, path: string, bytes: Uint8Array): boolean {
  const change = workingCopyChange(store, root, path, bytes);
  if (!change) return false;

  recordRevision(store, change.project, change.path, bytes, change.digest);
  return true;
}

export function recordWorkingCopy(store: Store, root: string, path: string): boolean {
  const bytes = readCopy(path);
  return bytes !== undefined && recordCopy(store, root, path, bytes);
}

export type RevisionEntry = {
  seq: number;
  path: string;
  sha256: string;
  captured: string;
  machine: string;
  bytes: number;
};

export function revisionsUnder(store: Store, prefix: string): RevisionEntry[] {
  const after = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
  return store.db
    .query(
      `SELECT seq, path, sha256, captured, machine, length(text) AS bytes
       FROM revisions WHERE path >= ? AND path < ? ORDER BY seq`,
    )
    .all(prefix, after) as RevisionEntry[];
}

export function revisionText(store: Store, seq: number): Uint8Array {
  const { text } = store.db.query("SELECT text FROM revisions WHERE seq = ?").get(seq) as {
    text: Uint8Array;
  };

  return text;
}

export const SPOOL = ".revisions-spool";

type Spooled = { file: string; path: string; captured: string; bytes: Uint8Array };

export function spoolRevision(root: string, path: string, bytes: Uint8Array, captured: string) {
  const folder = join(root, SPOOL);
  const name = `${captured.replaceAll(":", "")}-${Bun.randomUUIDv7()}`;
  const body = JSON.stringify({ path, captured, bytes: Buffer.from(bytes).toString("base64") });

  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `.${name}.tmp`), body);
  renameSync(join(folder, `.${name}.tmp`), join(folder, `${name}.json`));
}

function readSpooled(folder: string, file: string): Spooled | undefined {
  try {
    const entry = JSON.parse(readFileSync(join(folder, file), "utf8")) as Record<string, unknown>;
    const { path, captured, bytes } = entry;
    if (typeof path !== "string" || !isCopyKey(path)) return undefined;
    if (typeof captured !== "string" || Number.isNaN(Date.parse(captured))) return undefined;
    if (typeof bytes !== "string") return undefined;

    return { file, path, captured, bytes: Buffer.from(bytes, "base64") };
  } catch {
    return undefined;
  }
}

function spooled(folder: string): Spooled[] {
  let files: string[];
  try {
    files = readdirSync(folder).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }

  return files
    .flatMap((file) => readSpooled(folder, file) ?? [])
    .sort((a, b) => a.captured.localeCompare(b.captured) || a.file.localeCompare(b.file));
}

function superseded(store: Store, entry: Spooled, digest: string): boolean {
  const newest = store.db
    .query("SELECT sha256, captured FROM revisions WHERE path = ? ORDER BY seq DESC LIMIT 1")
    .get(entry.path) as { sha256: string; captured: string } | null;

  return newest !== null && (newest.sha256 === digest || newest.captured > entry.captured);
}

function isBusy(error: unknown): boolean {
  return String((error as { code?: unknown }).code).startsWith("SQLITE_BUSY");
}

export function drainSpool(store: Store, root: string, remove = true): boolean {
  const folder = join(root, SPOOL);
  const entries = spooled(folder);
  if (entries.length === 0) return true;

  try {
    write(store, () => {
      for (const entry of entries) {
        const digest = sha256(entry.bytes);
        if (superseded(store, entry, digest)) continue;

        const project = entry.path.split(sep)[0]!;
        recordRevision(store, project, entry.path, entry.bytes, digest, entry.captured);
      }
    });
  } catch (error) {
    if (isBusy(error)) return false;
    throw error;
  }

  if (!remove) return true;

  for (const entry of entries)
    try {
      rmSync(join(folder, entry.file), { force: true });
    } catch {}

  return true;
}

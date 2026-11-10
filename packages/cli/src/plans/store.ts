import { Database, type SQLQueryBindings } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  compareEvents,
  eventFrom,
  foldIssues,
  foldRows,
  historyOf,
  ISSUE_CLOSED,
  ISSUE_FILED,
  ISSUE_LINK,
  LEASE,
  LEASE_CONFLICT,
  LEASE_RELEASED,
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
  type Issue,
  type PlanEvent,
  type Stamp,
  type TrailEntry,
} from "skills-core";
import { plansDir } from "./index-tsv.ts";
import { markRecallBlob, rebuildRecall, upkeepRecall } from "./recall.ts";

export type Store = { db: Database; machine: string; clock: Clock };

type Migration = readonly string[] | ((db: Database) => void);

const MIGRATIONS: readonly Migration[] = [
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
  syncReady,
  rebuildRecall,
  ["CREATE TABLE IF NOT EXISTS landings (event TEXT PRIMARY KEY, state TEXT)"],
];

function syncReady(db: Database): void {
  db.run(`CREATE TABLE blobs (
    sha256 TEXT PRIMARY KEY,
    locator TEXT NOT NULL,
    bytes BLOB NOT NULL
  )`);

  db.run(
    `INSERT OR IGNORE INTO blobs (sha256, locator, bytes)
     SELECT sha256, lower(hex(randomblob(16))), text FROM revisions ORDER BY seq`,
  );

  for (const column of [
    "author TEXT",
    "sequence INTEGER",
    "previous TEXT",
    "signature BLOB",
    "envelope BLOB",
    "quarantined TEXT",
  ])
    db.run(`ALTER TABLE events ADD COLUMN ${column}`);

  db.run(
    `CREATE UNIQUE INDEX events_author ON events (author, sequence)
     WHERE author IS NOT NULL AND quarantined IS NULL`,
  );

  db.run(`CREATE TABLE revision_events (
    seq INTEGER PRIMARY KEY,
    event TEXT NOT NULL UNIQUE,
    project TEXT NOT NULL,
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    captured TEXT NOT NULL,
    machine TEXT NOT NULL,
    size INTEGER NOT NULL,
    locator TEXT NOT NULL
  )`);

  const old = db
    .query(
      `SELECT r.seq, r.project, r.path, r.sha256, r.captured, r.machine, length(r.text) AS size,
         b.locator
       FROM revisions r JOIN blobs b ON b.sha256 = r.sha256 ORDER BY r.seq`,
    )
    .all() as (Omit<Revision, "event"> & { seq: number })[];

  for (const revision of old) {
    const wall = Date.parse(revision.captured);
    if (!Number.isFinite(wall))
      throw new Error(`revision ${revision.seq} of ${revision.path} has no captured time`);

    const { counter } = db
      .query(
        "SELECT coalesce(max(counter) + 1, 0) AS counter FROM events WHERE wall = ? AND machine = ?",
      )
      .get(wall, revision.machine) as { counter: number };

    const id = insertEvent(db, {
      machine: revision.machine,
      wall,
      counter,
      ...recordOf(revisionDraft(wall, revision)),
    });

    db.run(
      `INSERT INTO revision_events
         (seq, event, project, path, sha256, captured, machine, size, locator)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        revision.seq,
        id,
        revision.project,
        revision.path,
        revision.sha256,
        revision.captured,
        revision.machine,
        revision.size,
        revision.locator,
      ],
    );
  }

  db.run("DROP TABLE revisions");
  db.run("ALTER TABLE revision_events RENAME TO revisions");
  db.run("CREATE INDEX revisions_path ON revisions (path, seq)");
  db.run("CREATE TABLE blob_uploads (sha256 TEXT PRIMARY KEY, queued INTEGER NOT NULL)");
  db.run(`CREATE TABLE blob_fetches (
    sha256 TEXT PRIMARY KEY,
    locator TEXT NOT NULL,
    event TEXT NOT NULL,
    queued INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  )`);

  db.run(`CREATE TABLE membership (
    position INTEGER PRIMARY KEY,
    hash TEXT NOT NULL UNIQUE,
    entry BLOB NOT NULL,
    signature BLOB NOT NULL
  )`);

  db.run(`CREATE TABLE cutoffs (
    author TEXT PRIMARY KEY,
    sequence INTEGER NOT NULL,
    hash TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE invites (
    id TEXT PRIMARY KEY,
    secret BLOB NOT NULL,
    label TEXT,
    expires INTEGER NOT NULL
  )`);
}

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

    for (const migration of MIGRATIONS.slice(version))
      if (typeof migration === "function") migration(db);
      else for (const statement of migration) db.run(statement);

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
    .query(
      `SELECT wall, counter FROM events WHERE quarantined IS NULL
       ORDER BY wall DESC, counter DESC LIMIT 1`,
    )
    .get() as Clock | null;

  return last ?? { wall: 0, counter: 0 };
}

export function write<T>(store: Store, edit: () => T): T {
  return store.db
    .transaction(() => {
      store.clock = lastClock(store.db);
      const result = edit();
      upkeepRecall(store.db);
      return result;
    })
    .immediate();
}

type Inserted = Omit<EventRecord, "payload"> & { payload: unknown };

function insertEvent(
  db: Database,
  event: Inserted,
  id = Bun.randomUUIDv7("hex", event.wall),
): string {
  db.run(
    `INSERT INTO events (id, machine, wall, counter, ts, project, plan, type, legacy, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      event.machine,
      event.wall,
      event.counter,
      event.ts,
      event.project,
      event.plan,
      event.type,
      event.legacy ? 1 : 0,
      JSON.stringify(event.payload),
    ],
  );

  return id;
}

export function appendEvent(store: Store, event: EventDraft): string {
  store.clock = tick(store.clock, event.at);
  return insertEvent(store.db, { machine: store.machine, ...store.clock, ...recordOf(event) });
}

const ROW_TYPES = ROW_EVENTS.map(() => "?").join(", ");

const NOT_ROWS = `type NOT IN (${ROW_TYPES}) AND type NOT IN (${STORE_EVENTS.map(() => "?").join(", ")})`;

const NOT_ROW_TYPES = [...ROW_EVENTS, ...STORE_EVENTS];

const TRAIL = `(legacy = 1 OR (${NOT_ROWS}))`;

const ORDER = "wall, counter, machine, id";

const NEWEST_FIRST = "wall DESC, counter DESC, machine DESC, id DESC";

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
    .query(
      `SELECT ${EVENT_COLUMNS} FROM events WHERE quarantined IS NULL AND ${where} ORDER BY ${ORDER}`,
    )
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
      `SELECT id, ${EVENT_COLUMNS} FROM events WHERE seq > ? AND quarantined IS NULL ORDER BY seq`,
    )
    .all(cursor.seq);

  return { kind: "events", events: rows.map(recordOfRow) };
}

export function blobBytes(db: Database, sha256: string): Uint8Array | undefined {
  return (
    db
      .query<{ bytes: Uint8Array }, [string]>("SELECT bytes FROM blobs WHERE sha256 = ?")
      .get(sha256)?.bytes ?? undefined
  );
}

export function projectedRows(store: Store): Map<string, Map<string, IndexRow>> {
  return foldRows(readEvents(store, `legacy = 0 AND type IN (${ROW_TYPES})`, [...ROW_EVENTS]));
}

const LEASE_TYPES = [LEASE, LEASE_RELEASED, LEASE_CONFLICT];
export function leaseEvents(store: Store, project?: string): PlanEvent[] {
  const types = `type IN (${LEASE_TYPES.map(() => "?").join(", ")})`;
  return project === undefined
    ? readEvents(store, types, LEASE_TYPES)
    : readEvents(store, `project = ? AND ${types}`, [project, ...LEASE_TYPES]);
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

export function storedIssues(
  store: Store,
  project?: string,
  until = Number.MAX_SAFE_INTEGER,
): Issue[] {
  const where = `legacy = 0 AND type IN (?, ?, ?) AND wall <= ?${project === undefined ? "" : " AND project = ?"}`;
  const params = [
    ISSUE_FILED,
    ISSUE_LINK,
    ISSUE_CLOSED,
    until,
    ...(project === undefined ? [] : [project]),
  ];

  return foldIssues(readEvents(store, where, params));
}

export function highestIssue(store: Store, project: string): number {
  const plans = store.db
    .query("SELECT plan FROM events WHERE legacy = 0 AND type = ? AND project = ?")
    .all(ISSUE_FILED, project) as { plan: string }[];

  return Math.max(0, ...plans.map(({ plan }) => Number(/^#([1-9][0-9]*)$/.exec(plan)?.[1] ?? 0)));
}

export function projectSince(store: Store, project: string): number | undefined {
  const first = store.db
    .query(
      `SELECT min(wall) AS wall FROM events
       WHERE project = ? AND legacy = 0 AND type IN (${ROW_TYPES}) AND quarantined IS NULL`,
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
       WHERE project = ? AND plan = ? AND quarantined IS NULL AND ${TRAIL}
         AND type NOT IN (SELECT value FROM json_each(?))
       ORDER BY ${NEWEST_FIRST}`,
    )
    .iterate(project, plan, ...NOT_ROW_TYPES, JSON.stringify(ignored)) as Iterable<EventRow>;

  for (const event of newestFirst) {
    const [entry] = trailOf([decode(event)]);
    if (entry) return { event: entry.event, detail: entry.detail };
  }

  return undefined;
}

export function trailEntries(store: Store): TrailEntry[] {
  return trailOf(readEvents(store, TRAIL, NOT_ROW_TYPES));
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
  const events = readEvents(store, `project = ? AND plan = ? AND ${TRAIL}`, [
    project,
    plan,
    ...NOT_ROW_TYPES,
  ]);

  return historyOf(trailOf(events));
}

export const RECORDED_HERE = `(e.machine = (SELECT value FROM meta WHERE key = 'machine')
  OR e.id IN (SELECT event FROM landings WHERE state = 'landed'))`;

export function latestRevision(store: Store, path: string): string | undefined {
  const revision = store.db
    .query(
      `SELECT r.sha256 FROM revisions r JOIN events e ON e.id = r.event
       WHERE r.path = ? AND ${RECORDED_HERE}
       ORDER BY r.seq DESC LIMIT 1`,
    )
    .get(path) as { sha256: string } | null;

  return revision?.sha256;
}

export function latestRevisionText(store: Store, path: string): Uint8Array | undefined {
  const revision = store.db
    .query(
      `SELECT b.bytes FROM revisions r
       JOIN events e ON e.id = r.event AND e.quarantined IS NULL
       LEFT JOIN blobs b ON b.sha256 = r.sha256
       WHERE r.path = ?
       ORDER BY e.wall DESC, e.counter DESC, e.machine DESC, e.id DESC LIMIT 1`,
    )
    .get(path) as { bytes: Uint8Array | null } | null;

  return revision?.bytes ?? undefined;
}

export type Revision = {
  event: string;
  project: string;
  path: string;
  sha256: string;
  captured: string;
  machine: string;
  size: number;
  locator: string;
};

export function planOfCopy(path: string): string {
  const name = basename(path, ".md");
  return CTX_FILE.test(basename(path)) ? name : name.slice(0, 3);
}

function revisionDraft(
  at: number,
  revision: Omit<Revision, "event" | "machine">,
  base?: string,
): EventDraft {
  const { project, path, sha256, captured, size, locator } = revision;
  const payload = { path, sha256, captured, size, blob: locator };
  return {
    kind: "stored",
    type: "revision",
    at,
    project,
    plan: planOfCopy(path),
    payload: base === undefined ? payload : { ...payload, base },
  };
}

export function counterparts(path: string): string[] {
  const parts = path.split(sep);
  if (parts.length === 3 && parts[1] === "done") return [path, join(parts[0]!, parts[2]!)];
  if (parts.length === 2) return [path, join(parts[0]!, "done", parts[1]!)];
  return [path];
}

export function newestRecordedOf(store: Store, path: string): string | undefined {
  const newest = store.db
    .query(
      `SELECT r.sha256 FROM revisions r JOIN events e ON e.id = r.event AND e.quarantined IS NULL
       WHERE r.path IN (SELECT value FROM json_each(?)) AND ${RECORDED_HERE}
       ORDER BY r.seq DESC LIMIT 1`,
    )
    .get(JSON.stringify(counterparts(path))) as { sha256: string } | null;

  return newest?.sha256;
}

export function storeBlob(
  store: Store,
  digest: string,
  bytes: Uint8Array,
  locator: string,
): boolean {
  const stored = store.db.run(
    "INSERT OR IGNORE INTO blobs (sha256, locator, bytes) VALUES (?, ?, ?)",
    [digest, locator, bytes],
  );

  store.db.run("DELETE FROM blob_fetches WHERE sha256 = ?", [digest]);
  if (stored.changes === 0) return false;

  markRecallBlob(store.db, digest);
  return true;
}

function locatorOf(store: Store, digest: string): string {
  const blob = store.db.query("SELECT locator FROM blobs WHERE sha256 = ?").get(digest) as {
    locator: string;
  } | null;

  return blob?.locator ?? Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
}

export function insertRevision(store: Store, revision: Revision): void {
  const { event, project, path, sha256, captured, machine, size, locator } = revision;
  store.db.run(
    `INSERT INTO revisions (event, project, path, sha256, captured, machine, size, locator)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [event, project, path, sha256, captured, machine, size, locator],
  );
}

export function recordRevision(
  store: Store,
  project: string,
  path: string,
  text: Uint8Array,
  sha256: string,
  captured = new Date().toISOString(),
): void {
  store.db.transaction(() => {
    const locator = locatorOf(store, sha256);
    const revision = { project, path, sha256, captured, size: text.byteLength, locator };

    const base = newestRecordedOf(store, path);
    storeBlob(store, sha256, text, locator);
    const event = appendEvent(store, revisionDraft(Date.parse(captured), revision, base));
    insertRevision(store, { ...revision, event, machine: store.machine });
  })();
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

export function isCopyKey(stored: string): boolean {
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

export type RevisionEntry = Stamp & {
  seq: number;
  event: string;
  path: string;
  sha256: string;
  captured: string;
  bytes: number;
  stored: boolean;
};

export function compareRevisions(left: RevisionEntry, right: RevisionEntry): number {
  return (
    compareEvents(left, right) || (left.event < right.event ? -1 : left.event > right.event ? 1 : 0)
  );
}

export function revisionsUnder(store: Store, prefix: string): RevisionEntry[] {
  const after = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
  const entries = store.db
    .query(
      `SELECT r.seq, r.event, r.path, r.sha256, r.captured, e.machine, e.wall, e.counter,
         r.size AS bytes, b.sha256 IS NOT NULL AS stored
       FROM revisions r
       JOIN events e ON e.id = r.event AND e.quarantined IS NULL
       LEFT JOIN blobs b ON b.sha256 = r.sha256
       WHERE r.path >= ? AND r.path < ?`,
    )
    .all(prefix, after) as (Omit<RevisionEntry, "stored"> & { stored: number })[];

  return entries.map((entry) => ({ ...entry, stored: entry.stored === 1 })).sort(compareRevisions);
}

export function revisionText(store: Store, sha256: string): Uint8Array | undefined {
  const blob = store.db.query("SELECT bytes FROM blobs WHERE sha256 = ?").get(sha256) as {
    bytes: Uint8Array;
  } | null;

  return blob?.bytes;
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
    .query(
      `SELECT r.sha256, r.captured FROM revisions r JOIN events e ON e.id = r.event
       WHERE r.path = ? AND ${RECORDED_HERE}
       ORDER BY r.seq DESC LIMIT 1`,
    )
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

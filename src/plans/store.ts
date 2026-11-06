import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { COLUMNS, formatRow, plansDir, type IndexRow } from "./index-tsv.ts";
import { AD_HOC_EVENTS } from "./threads.ts";
import { AD_HOC_ID, LOG_HEADER } from "./trail.ts";

export const TRAIL_EVENTS = [
  "start",
  "review",
  "handback",
  "done",
  "thread",
  "wave",
  "nudge",
  "conflict-sent",
] as const;

export const ROW_EVENTS = ["added", "row", "imported"] as const;

export type TrailEvent = (typeof TRAIL_EVENTS)[number];
export type RowEvent = (typeof ROW_EVENTS)[number];

export type Clock = { wall: number; counter: number };

export type Store = { db: Database; machine: string; clock: Clock };

export type TrailPayload = { detail: string; line: string };
export type RowPayload = { row: IndexRow };

export type NewEvent =
  | { type: RowEvent; at: number; project: string; plan: string; payload: RowPayload }
  | { type: string; at: number; ts: string; project: string; plan: string; payload: TrailPayload };

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
] as const;

export function storePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(plansDir(env), "plans.db");
}

export function openStore(path: string, fresh = false): Store {
  const db = new Database(path, { create: fresh, readwrite: true, strict: true });
  try {
    db.run("PRAGMA busy_timeout = 10000");
    if (!fresh) db.run("PRAGMA journal_mode = WAL");
    migrate(db);

    return { db, machine: machineId(db), clock: lastClock(db) };
  } catch (error) {
    db.close();
    throw error;
  }
}

function migrate(db: Database): void {
  db.transaction(() => {
    const { user_version: version } = db.query("PRAGMA user_version").get() as {
      user_version: number;
    };

    if (version > MIGRATIONS.length)
      throw new Error(`plans.db schema ${version} is newer than this release`);

    for (const statements of MIGRATIONS.slice(version))
      for (const statement of statements) db.run(statement);

    db.run(`PRAGMA user_version = ${MIGRATIONS.length}`);
  }).immediate();
}

function machineId(db: Database): string {
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

export function tick(last: Clock, physical: number): Clock {
  return Number.isFinite(physical) && physical > last.wall
    ? { wall: physical, counter: 0 }
    : { wall: last.wall, counter: last.counter + 1 };
}

export function secondStamp(milliseconds: number): string {
  return new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function isKnownEvent(event: NewEvent): boolean {
  if ("ts" in event)
    return event.plan === AD_HOC_ID
      ? (AD_HOC_EVENTS as readonly string[]).includes(event.type)
      : (TRAIL_EVENTS as readonly string[]).includes(event.type);

  return (ROW_EVENTS as readonly string[]).includes(event.type);
}

export function appendEvent(store: Store, event: NewEvent): void {
  store.clock = tick(store.clock, event.at);

  const ts = "ts" in event ? event.ts : secondStamp(event.at);
  store.db.run(
    `INSERT INTO events (id, machine, wall, counter, ts, project, plan, type, legacy, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Bun.randomUUIDv7("hex", store.clock.wall),
      store.machine,
      store.clock.wall,
      store.clock.counter,
      ts,
      event.project,
      event.plan,
      event.type,
      isKnownEvent(event) ? 0 : 1,
      JSON.stringify(event.payload),
    ],
  );
}

export function rowKey(row: Pick<IndexRow, "id" | "slug">): string {
  return `${row.id}\t${row.slug}`;
}

export function projectedRows(store: Store): Map<string, Map<string, IndexRow>> {
  const projects = new Map<string, Map<string, IndexRow>>();
  const events = store.db
    .query(
      `SELECT project, payload FROM events
       WHERE legacy = 0 AND type IN (${ROW_EVENTS.map(() => "?").join(", ")})
       ORDER BY seq`,
    )
    .all(...ROW_EVENTS) as { project: string; payload: string }[];

  for (const event of events) {
    const { row } = JSON.parse(event.payload) as RowPayload;
    const rows = projects.get(event.project) ?? new Map<string, IndexRow>();

    projects.set(event.project, rows);
    rows.set(rowKey(row), row);
  }

  return projects;
}

export function trailLines(store: Store): string[] {
  const events = store.db
    .query(
      `SELECT payload ->> '$.line' AS line FROM events
       WHERE legacy = 1 OR type NOT IN (${ROW_EVENTS.map(() => "?").join(", ")}) ORDER BY seq`,
    )
    .all(...ROW_EVENTS) as { line: string }[];

  return events.map((event) => event.line);
}

export function renderIndex(rows: Iterable<IndexRow>): string {
  return [COLUMNS.join("\t"), ...Array.from(rows, formatRow)].map((line) => `${line}\n`).join("");
}

export function renderTrail(lines: readonly string[]): string {
  return LOG_HEADER + lines.map((line) => `${line}\n`).join("");
}

export function importedViews(store: Store): string[] {
  const views = store.db.query("SELECT path FROM views ORDER BY path").all() as { path: string }[];
  return views.map((view) => view.path);
}

export function recordView(store: Store, path: string): void {
  store.db.run("INSERT OR IGNORE INTO views (path) VALUES (?)", [path]);
}

export function latestRevision(store: Store, path: string): string | undefined {
  const revision = store.db
    .query("SELECT sha256 FROM revisions WHERE path = ? ORDER BY seq DESC LIMIT 1")
    .get(path) as { sha256: string } | null;

  return revision?.sha256;
}

export function recordRevision(
  store: Store,
  project: string,
  path: string,
  text: Uint8Array,
  sha256: string,
): void {
  store.db.run(
    "INSERT INTO revisions (project, path, sha256, text, captured, machine) VALUES (?, ?, ?, ?, ?, ?)",
    [project, path, sha256, text, new Date().toISOString(), store.machine],
  );
}

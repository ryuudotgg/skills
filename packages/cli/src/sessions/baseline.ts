import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { SESSION_EVENT, type Host, type SessionStats } from "skills-core";
import type { Store } from "../plans/store.ts";
import { SCAN_DB, sessionKey } from "./policy.ts";
import { foldStats, lessStats, type Progress } from "./transcripts.ts";

export type Baseline = { elsewhere: SessionStats; after: number; resumed: boolean };

export type Held = { newest: SessionStats | undefined; seq: number };

type Row = { key: string; stats: string; copy: string; after: number; resumed: number };

export function ensureBaselines(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS baselines (
    key TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    length INTEGER NOT NULL,
    stats TEXT NOT NULL,
    copy TEXT NOT NULL,
    after INTEGER NOT NULL,
    resumed INTEGER NOT NULL DEFAULT 0
  )`);
}

export function openBaselines(root: string): Database {
  const db = new Database(join(root, SCAN_DB), { create: true, strict: true });
  try {
    db.run("PRAGMA busy_timeout = 10000");
    ensureBaselines(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function readBaselines(db: Database): Map<string, Baseline> {
  const rows = db.query("SELECT key, stats, copy, after, resumed FROM baselines").all() as Row[];
  return new Map(
    rows.map((row) => {
      const stats = JSON.parse(row.stats) as SessionStats;
      const copy = JSON.parse(row.copy) as SessionStats;
      const baseline = { elsewhere: lessStats(stats, copy), after: row.after };
      return [row.key, { ...baseline, resumed: row.resumed === 1 }];
    }),
  );
}

class Unlinked extends Error {}

export function publishRestored(
  db: Database,
  written: Progress,
  held: Held,
  link: () => boolean,
): boolean {
  const { host, session } = written;
  const copy = foldStats(host, session, [written]);
  const row = [
    sessionKey(host, session),
    written.path,
    written.offset,
    JSON.stringify(held.newest ?? copy),
    JSON.stringify(copy),
    held.seq,
  ];

  let linked = false;
  try {
    db.transaction(() => {
      db.run(
        `INSERT OR REPLACE INTO baselines (key, path, length, stats, copy, after, resumed)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
        row,
      );

      linked = link();
      if (!linked) throw new Unlinked();
    }).immediate();

    return true;
  } catch (error) {
    if (error instanceof Unlinked) return false;
    if (linked) rmSync(written.path, { force: true });
    throw error;
  }
}

export function markResumed(db: Database, key: string): void {
  db.run("UPDATE baselines SET resumed = 1 WHERE key = ?", [key]);
}

export function unresumed(
  store: Store,
  baselines: ReadonlyMap<string, Baseline>,
  among: Iterable<string> = baselines.keys(),
): Set<string> {
  const keys = new Set([...among].filter((key) => baselines.get(key)?.resumed === false));
  if (keys.size === 0) return keys;

  const after = Math.min(...[...keys].map((key) => baselines.get(key)!.after));
  const rows = store.db
    .query(
      `SELECT seq, payload FROM events
       WHERE type = ? AND machine = ? AND seq > ? AND legacy = 0 AND quarantined IS NULL`,
    )
    .all(SESSION_EVENT, store.machine, after) as { seq: number; payload: string }[];

  for (const row of rows) {
    const { host, session } = JSON.parse(row.payload) as { host: Host; session: string };
    const key = sessionKey(host, session);
    if (row.seq > (baselines.get(key)?.after ?? Number.POSITIVE_INFINITY)) keys.delete(key);
  }

  return keys;
}

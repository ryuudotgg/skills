import { Database } from "bun:sqlite";
import { join } from "node:path";
import { SESSION_EVENT, type Host, type SessionStats } from "skills-core";
import type { Store } from "../plans/store.ts";
import { SCAN_DB, sessionKey } from "./policy.ts";
import { foldStats, lessStats, type Progress } from "./transcripts.ts";

export type Baseline = { elsewhere: SessionStats; resumed: boolean };

type Row = { key: string; stats: string; copy: string; resumed: number };

export function ensureBaselines(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS baselines (
    key TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    length INTEGER NOT NULL,
    stats TEXT NOT NULL,
    copy TEXT NOT NULL,
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
  const rows = db.query("SELECT key, stats, copy, resumed FROM baselines").all() as Row[];
  return new Map(
    rows.map((row) => {
      const stats = JSON.parse(row.stats) as SessionStats;
      const copy = JSON.parse(row.copy) as SessionStats;
      return [row.key, { elsewhere: lessStats(stats, copy), resumed: row.resumed === 1 }];
    }),
  );
}

class Unlinked extends Error {}

export function publishRestored(
  db: Database,
  written: Progress,
  newest: SessionStats | undefined,
  link: () => boolean,
): boolean {
  const { host, session } = written;
  const copy = foldStats(host, session, [written]);
  const row = [
    sessionKey(host, session),
    written.path,
    written.offset,
    JSON.stringify(newest ?? copy),
    JSON.stringify(copy),
  ];

  try {
    db.transaction(() => {
      db.run(
        `INSERT OR REPLACE INTO baselines (key, path, length, stats, copy, resumed)
         VALUES (?, ?, ?, ?, ?, 0)`,
        row,
      );

      if (!link()) throw new Unlinked();
    }).immediate();

    return true;
  } catch (error) {
    if (error instanceof Unlinked) return false;
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

  const rows = store.db
    .query(
      `SELECT payload FROM events
       WHERE type = ? AND machine = ? AND legacy = 0 AND quarantined IS NULL`,
    )
    .all(SESSION_EVENT, store.machine) as { payload: string }[];

  for (const row of rows) {
    const { host, session } = JSON.parse(row.payload) as { host: Host; session: string };
    keys.delete(sessionKey(host, session));
  }

  return keys;
}

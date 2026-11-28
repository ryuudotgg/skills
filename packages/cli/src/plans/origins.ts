import { existsSync } from "node:fs";
import { join } from "node:path";
import { factsFrom, MACHINE_EVENT } from "skills-core";
import { openReadOnly } from "./store.ts";

export type RecordedOrigin = { project: string; origin: string };

const BUSY_MS = 100;

const NEWEST_PER_MACHINE = `SELECT payload FROM events WHERE seq IN (
  SELECT seq FROM (
    SELECT seq, row_number() OVER (PARTITION BY machine ORDER BY wall DESC, counter DESC) AS rank
    FROM events
    WHERE project = '-' AND plan = '-' AND type = ? AND legacy = 0 AND quarantined IS NULL
  ) WHERE rank = 1
)`;

function originsOf(payload: string): RecordedOrigin[] {
  try {
    const checkouts = factsFrom(JSON.parse(payload))?.checkouts ?? {};
    return Object.entries(checkouts).flatMap(([project, { origin }]) =>
      origin === null ? [] : [{ project, origin }],
    );
  } catch {
    return [];
  }
}

export function recordedOrigins(plansDir: string): RecordedOrigin[] {
  const path = join(plansDir, "plans.db");
  if (!existsSync(path)) return [];

  try {
    const db = openReadOnly(path, BUSY_MS);
    try {
      const rows = db.query<{ payload: string }, [string]>(NEWEST_PER_MACHINE).all(MACHINE_EVENT);
      return rows.flatMap(({ payload }) => originsOf(payload));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

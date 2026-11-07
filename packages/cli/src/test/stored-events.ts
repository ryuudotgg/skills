import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type Stored = { project: string; plan: string; payload: Record<string, unknown> };

export function storedEvents(plans: string, type: string): Stored[] {
  const path = join(plans, "plans.db");
  if (!existsSync(path)) return [];

  const db = new Database(path, { readwrite: true, create: false });
  try {
    const rows = db
      .query("SELECT project, plan, payload FROM events WHERE type = ? ORDER BY seq")
      .all(type) as { project: string; plan: string; payload: string }[];

    return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  } finally {
    db.close();
  }
}

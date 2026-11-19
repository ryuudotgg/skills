import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AD_HOC_ID,
  projectPolicy,
  isSessionPolicy,
  POLICY_EVENT,
  SESSION_EVENT,
  SESSION_STATS_EVENT,
  sessionKey,
  strictestPolicy,
  TRANSCRIPT_EVENT,
  type Host,
  type SessionPolicy,
} from "skills-core";
import type { Store } from "../plans/store.ts";
import { object } from "./jsonl.ts";

export { sessionKey };

export type Policies = Map<string, SessionPolicy>;

export type Links = Map<string, Set<string>>;

export const SCAN_DB = "sessions-scan.db";

const LINK_BUSY_MS = 200;

export function ensureLinks(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS withheld (
    key TEXT NOT NULL,
    project TEXT NOT NULL,
    PRIMARY KEY (key, project)
  )`);
}

export function readLinks(db: Database): Links {
  const rows = db.query("SELECT key, project FROM withheld").all() as {
    key: string;
    project: string;
  }[];

  const links: Links = new Map();
  for (const row of rows) links.set(row.key, (links.get(row.key) ?? new Set()).add(row.project));
  return links;
}

export function localLinks(root: string, { readonly = false } = {}): Links {
  const path = join(root, SCAN_DB);
  if (!existsSync(path)) return new Map();

  const db = readonly
    ? new Database(path, { readonly: true })
    : new Database(path, { readwrite: true, create: false });

  try {
    const table = db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'withheld'")
      .get();

    return table ? readLinks(db) : new Map();
  } finally {
    db.close();
  }
}

export function saveLink(db: Database, key: string, project: string): void {
  db.run("INSERT OR IGNORE INTO withheld (key, project) VALUES (?, ?)", [key, project]);
}

function holdLink(root: string, key: string, project: string): void {
  const db = new Database(join(root, SCAN_DB), { create: true, strict: true });
  try {
    db.run(`PRAGMA busy_timeout = ${LINK_BUSY_MS}`);
    ensureLinks(db);
    saveLink(db, key, project);
  } finally {
    db.close();
  }
}

export type PolicyChange = {
  project: string;
  wall: number;
  earliest: number;
  policy: SessionPolicy;
};

export type Window = { from: number; to: number };

export function policyChanges(store: Pick<Store, "db">): PolicyChange[] {
  const rows = store.db
    .query(
      `SELECT project, wall, ts, payload FROM events WHERE type = ? AND quarantined IS NULL
       ORDER BY wall, counter, machine, id`,
    )
    .all(POLICY_EVENT) as { project: string; wall: number; ts: string; payload: string }[];

  return rows.flatMap((row) => {
    const payload: unknown = JSON.parse(row.payload);
    if (!object(payload) || !isSessionPolicy(payload.policy)) return [];

    const stamped = Date.parse(row.ts);
    const earliest = Number.isNaN(stamped) ? row.wall : Math.min(row.wall, stamped);
    return [{ project: row.project, wall: row.wall, earliest, policy: payload.policy }];
  });
}

export function projectPolicies(store: Pick<Store, "db">): Policies {
  return new Map(policyChanges(store).map((change) => [change.project, change.policy]));
}

export function statsWindows(
  changes: readonly PolicyChange[],
  projects: ReadonlySet<string>,
): Window[] {
  const open = new Map<string, number>();
  const windows: Window[] = [];
  for (const change of changes) {
    if (!projects.has(change.project)) continue;

    const from = open.get(change.project);
    if (change.policy === "stats") {
      open.set(change.project, Math.min(from ?? change.earliest, change.earliest));
      continue;
    }

    if (from === undefined) continue;

    windows.push({ from, to: change.wall });
    open.delete(change.project);
  }

  return windows;
}

export function sessionPolicy(policies: Policies, projects: Iterable<string>): SessionPolicy {
  return strictestPolicy([...projects].map((project) => projectPolicy(policies, project))) ?? "off";
}

export function silenced(policies: Policies, projects: Iterable<string>): boolean {
  return [...projects].some((project) => project !== AD_HOC_ID && policies.get(project) === "off");
}

export function silencedSessions(
  store: Pick<Store, "db">,
  policies: Policies,
  links: Links,
): Set<string> {
  const quiet = new Set<string>();
  for (const [key, projects] of links) if (silenced(policies, projects)) quiet.add(key);

  const off = [...policies.keys()].filter((project) => silenced(policies, [project]));
  if (!off.length) return quiet;

  const rows = store.db
    .query(
      `SELECT DISTINCT json_extract(payload, '$.host') AS host,
         json_extract(payload, '$.session') AS session
       FROM events WHERE type IN (?, ?) AND legacy = 0 AND quarantined IS NULL
         AND project IN (${off.map(() => "?").join(", ")})`,
    )
    .all(SESSION_EVENT, SESSION_STATS_EVENT, ...off) as { host: Host; session: string }[];

  for (const row of rows) quiet.add(sessionKey(row.host, row.session));
  return quiet;
}

export function withholdsSession(
  store: Store,
  root: string,
  project: string,
  record: { host: Host; session: string },
): boolean {
  const key = sessionKey(record.host, record.session);
  const policies = projectPolicies(store);
  if (silenced(policies, [project])) {
    holdLink(root, key, project);
    return true;
  }

  return silencedSessions(store, policies, localLinks(root)).has(key);
}

export function sessionProjects(store: Store, links: Links): Map<string, Set<string>> {
  const rows = store.db
    .query(
      `SELECT DISTINCT project, json_extract(payload, '$.host') AS host,
         json_extract(payload, '$.session') AS session
       FROM events WHERE type IN (?, ?, ?) AND legacy = 0 AND quarantined IS NULL`,
    )
    .all(SESSION_EVENT, SESSION_STATS_EVENT, TRANSCRIPT_EVENT) as {
    project: string;
    host: Host;
    session: string;
  }[];

  const projects = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = sessionKey(row.host, row.session);
    projects.set(key, (projects.get(key) ?? new Set()).add(row.project));
  }

  for (const [key, linked] of links)
    projects.set(key, new Set([...(projects.get(key) ?? []), ...linked]));

  return projects;
}

export function sessionPolicies(store: Store, links: Links): Map<string, SessionPolicy> {
  const policies = projectPolicies(store);
  return new Map(
    [...sessionProjects(store, links)].map(([key, linked]) => [
      key,
      sessionPolicy(policies, linked),
    ]),
  );
}

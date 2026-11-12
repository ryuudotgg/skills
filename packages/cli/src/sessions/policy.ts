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
  strictestPolicy,
  TRANSCRIPT_EVENT,
  type Host,
  type SessionPolicy,
} from "skills-core";
import type { Store } from "../plans/store.ts";
import { object } from "./jsonl.ts";

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

export function sessionKey(host: Host, session: string): string {
  return `${host}\t${session}`;
}

export function projectPolicies(store: Pick<Store, "db">): Policies {
  const rows = store.db
    .query(
      `SELECT project, payload FROM events WHERE type = ? AND quarantined IS NULL
       ORDER BY wall, counter, machine, id`,
    )
    .all(POLICY_EVENT) as { project: string; payload: string }[];

  const policies: Policies = new Map();
  for (const row of rows) {
    const payload: unknown = JSON.parse(row.payload);
    if (object(payload) && isSessionPolicy(payload.policy))
      policies.set(row.project, payload.policy);
  }

  return policies;
}

export function sessionPolicy(policies: Policies, projects: Iterable<string>): SessionPolicy {
  return strictestPolicy([...projects].map((project) => projectPolicy(policies, project))) ?? "off";
}

export function silenced(policies: Policies, projects: Iterable<string>): boolean {
  return [...projects].some((project) => project !== AD_HOC_ID && policies.get(project) === "off");
}

export function silencedSessions(store: Store, policies: Policies, links: Links): Set<string> {
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

export function sessionPolicies(store: Store, links: Links): Map<string, SessionPolicy> {
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

  const policies = projectPolicies(store);
  return new Map([...projects].map(([key, linked]) => [key, sessionPolicy(policies, linked)]));
}

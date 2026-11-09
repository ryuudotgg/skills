import type { Database } from "bun:sqlite";
import { basename, dirname, join } from "node:path";
import {
  AD_HOC_ID,
  eventFrom,
  foldIssues,
  ISSUE_CLOSED,
  ISSUE_FILED,
  issuePlan,
  ROW_EVENTS,
  STORE_EVENTS,
  type EventRecord,
  type IndexRow,
  type Issue,
} from "skills-core";

export type Owner =
  | { kind: "file"; project: string; name: string }
  | { kind: "issue"; project: string; plan: string }
  | { kind: "trail"; id: string };

export type RecallDocument = {
  slug: string;
  section: string;
  body: string;
  project: string;
  ref: string;
  path: string;
  recorded: string;
};

export const TRAIL_PATH = "log.tsv";

export const ISSUE_PATH = "-";

const COLUMNS =
  "slug, section, body, project UNINDEXED, ref UNINDEXED, path UNINDEXED, recorded UNINDEXED";

const NOT_TRAIL = new Set<string>([...ROW_EVENTS, ...STORE_EVENTS]);

export function rebuildRecall(db: Database): void {
  for (const table of ["recall", "recall_trigram", "recall_docs", "recall_state"])
    db.run(`DROP TABLE IF EXISTS ${table}`);

  db.run(`CREATE VIRTUAL TABLE recall USING fts5(${COLUMNS}, tokenize = 'porter unicode61')`);
  db.run(`CREATE VIRTUAL TABLE recall_trigram USING fts5(${COLUMNS}, tokenize = 'trigram')`);

  for (const table of ["recall", "recall_trigram"])
    db.run(`INSERT INTO ${table} (${table}, rank) VALUES ('automerge', 0)`);

  db.run("CREATE TABLE recall_docs (id INTEGER PRIMARY KEY, owner TEXT NOT NULL)");
  db.run("CREATE INDEX recall_docs_owner ON recall_docs (owner)");
  db.run("CREATE TABLE recall_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");

  foldRecall(db);
}

export function sections(text: string): { section: string; body: string }[] {
  const found: { section: string; lines: string[] }[] = [];

  const lines = text.split("\n");
  const fence = (line: string) => line.replace(/\r$/, "") === "---";
  const closing = fence(lines[0] ?? "") ? lines.findIndex((line, at) => at > 0 && fence(line)) : -1;

  let fenced = false;
  for (const line of lines.slice(closing + 1)) {
    if (/^[ \t]*```/.test(line)) fenced = !fenced;
    else if (!fenced && line.startsWith("## ")) {
      found.push({ section: line.slice(3).trim(), lines: [] });
      continue;
    }

    found.at(-1)?.lines.push(line);
  }

  return found.map(({ section, lines }) => ({ section, body: lines.join("\n").trim() }));
}

function ownerKey(owner: Owner): string {
  if (owner.kind === "trail") return `trail\t${owner.id}`;
  if (owner.kind === "issue") return `issue\t${owner.project}\t${owner.plan}`;
  return `file\t${owner.project}\t${owner.name}`;
}

function isCtx(name: string): boolean {
  return name.startsWith("ctx-");
}

function iso(time: number | string): string {
  return new Date(time).toISOString();
}

function fileOwner(project: string, path: string): Owner | undefined {
  const name = basename(path);
  const folder = dirname(path);
  if (!name.endsWith(".md")) return undefined;

  const plan = /^\d{3}-/.test(name);
  if (folder === project && (plan || isCtx(name))) return { kind: "file", project, name };
  if (folder === join(project, "done") && plan) return { kind: "file", project, name };

  return undefined;
}

type NewestCopy = { path: string; captured: string; bytes: Uint8Array | null };

function fileDocuments(db: Database, project: string, name: string): RecallDocument[] {
  const paths = isCtx(name)
    ? [join(project, name)]
    : [join(project, name), join(project, "done", name)];

  const newest = db
    .query(
      `SELECT r.path, r.captured, b.bytes FROM revisions r
       JOIN events e ON e.id = r.event AND e.quarantined IS NULL
       LEFT JOIN blobs b ON b.sha256 = r.sha256
       WHERE r.path IN (SELECT value FROM json_each(?))
       ORDER BY e.wall DESC, e.counter DESC, e.machine DESC, e.id DESC LIMIT 1`,
    )
    .get(JSON.stringify(paths)) as NewestCopy | null;

  if (!newest?.bytes) return [];

  const stem = basename(name, ".md");
  const ref = isCtx(name) ? stem : stem.slice(0, 3);
  const slug = isCtx(name) ? stem : stem.slice(4);
  const text = new TextDecoder().decode(newest.bytes);
  const recorded = iso(newest.captured);

  return sections(text).map(({ section, body }) => ({
    slug,
    section,
    body,
    project,
    ref,
    path: newest.path,
    recorded,
  }));
}

type EventRow = Omit<EventRecord, "legacy" | "payload"> & { legacy: number; payload: string };

const EVENT_COLUMNS = "machine, wall, counter, ts, project, plan, type, legacy, payload";

function record(row: EventRow): EventRecord {
  return { ...row, legacy: row.legacy === 1, payload: JSON.parse(row.payload) as unknown };
}

function trailDocuments(db: Database, id: string): RecallDocument[] {
  const row = db
    .query(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = ? AND quarantined IS NULL`)
    .get(id) as EventRow | null;

  if (!row) return [];

  const event = eventFrom(record(row));
  if (event.kind !== "trail" || event.detail === "") return [];

  return [
    {
      slug: "",
      section: "trail",
      body: event.detail,
      project: event.project,
      ref: event.plan,
      path: TRAIL_PATH,
      recorded: iso(event.wall),
    },
  ];
}

function issueDocuments(db: Database, project: string, plan: string): RecallDocument[] {
  const rows = db
    .query(
      `SELECT ${EVENT_COLUMNS} FROM events
       WHERE project = ? AND type IN (?, ?) AND plan = ? AND legacy = 0 AND quarantined IS NULL
       ORDER BY wall, counter, machine, id`,
    )
    .all(project, ISSUE_FILED, ISSUE_CLOSED, plan) as EventRow[];

  const [issue] = foldIssues(rows.map((row) => eventFrom(record(row))));
  if (!issue) return [];

  return [
    {
      slug: "",
      section: "issue",
      body: issue.body === null ? issue.title : `${issue.title}\n\n${issue.body}`,
      project,
      ref: plan,
      path: ISSUE_PATH,
      recorded: iso(Math.max(...rows.map((row) => row.wall))),
    },
  ];
}

function documentsOf(db: Database, owner: Owner): RecallDocument[] {
  try {
    if (owner.kind === "trail") return trailDocuments(db, owner.id);
    if (owner.kind === "issue") return issueDocuments(db, owner.project, owner.plan);
    return fileDocuments(db, owner.project, owner.name);
  } catch {
    return [];
  }
}

function refresh(db: Database, owners: Iterable<Owner>): void {
  const byKey = new Map([...owners].map((owner) => [ownerKey(owner), owner]));
  for (const [key, owner] of byKey) {
    const stale = db.query("SELECT id FROM recall_docs WHERE owner = ?").all(key) as {
      id: number;
    }[];

    for (const { id } of stale) {
      db.run("DELETE FROM recall WHERE rowid = ?", [id]);
      db.run("DELETE FROM recall_trigram WHERE rowid = ?", [id]);
    }

    db.run("DELETE FROM recall_docs WHERE owner = ?", [key]);

    for (const document of documentsOf(db, owner)) {
      const { id } = db
        .query("INSERT INTO recall_docs (owner) VALUES (?) RETURNING id")
        .get(key) as { id: number };

      const values = [
        id,
        document.slug,
        document.section,
        document.body,
        document.project,
        document.ref,
        document.path,
        document.recorded,
      ];

      for (const table of ["recall", "recall_trigram"])
        db.run(
          `INSERT INTO ${table} (rowid, slug, section, body, project, ref, path, recorded)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          values,
        );
    }
  }
}

type EventHead = { id: string; project: string; plan: string; type: string; legacy: number };

function ownerOfEvent(db: Database, event: EventHead): Owner | undefined {
  if (event.type === "revision" && event.legacy === 0) {
    const revision = db
      .query("SELECT project, path FROM revisions WHERE event = ?")
      .get(event.id) as { project: string; path: string } | null;

    return revision ? fileOwner(revision.project, revision.path) : undefined;
  }

  if ((event.type === ISSUE_FILED || event.type === ISSUE_CLOSED) && event.legacy === 0)
    return { kind: "issue", project: event.project, plan: event.plan };

  if (event.legacy === 1 || !NOT_TRAIL.has(event.type)) return { kind: "trail", id: event.id };

  return undefined;
}

type Pending = { owners: Owner[]; blobs: Set<string> };

const pending = new WeakMap<Database, Pending>();
function pendingOf(db: Database): Pending {
  const known = pending.get(db);
  if (known) return known;

  const fresh = { owners: [], blobs: new Set<string>() };
  pending.set(db, fresh);
  return fresh;
}

export function upkeepRecall(db: Database): void {
  db.run("SAVEPOINT recall");

  try {
    foldRecall(db);
  } catch {
    db.run("ROLLBACK TO recall");
    db.run("UPDATE recall_state SET value = 0");
  }

  db.run("RELEASE recall");
}

export function markRecallEvents(db: Database, ids: Iterable<string>): void {
  const { owners } = pendingOf(db);
  for (const id of ids) {
    const event = db
      .query("SELECT id, project, plan, type, legacy FROM events WHERE id = ?")
      .get(id) as EventHead | null;

    const owner = event && ownerOfEvent(db, event);
    if (owner) owners.push(owner);
  }
}

export function markRecallBlob(db: Database, sha256: string): void {
  pendingOf(db).blobs.add(sha256);
}

function stateOf(db: Database, key: string): number {
  const row = db.query("SELECT value FROM recall_state WHERE key = ?").get(key) as {
    value: number;
  } | null;

  return row?.value ?? 0;
}

function setState(db: Database, key: string, value: number): void {
  db.run(
    `INSERT INTO recall_state (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

export function recallBehind(db: Database): boolean {
  const newest = (table: string) =>
    (db.query(`SELECT coalesce(max(seq), 0) AS seq FROM ${table}`).get() as { seq: number }).seq;

  return (
    newest("revisions") > stateOf(db, "revision_seq") || newest("events") > stateOf(db, "event_seq")
  );
}

type Located = { project: string; path: string };

export function foldRecall(db: Database): void {
  const marked = pendingOf(db);
  pending.delete(db);

  const revisionSeq = stateOf(db, "revision_seq");
  const eventSeq = stateOf(db, "event_seq");
  const revisions = db
    .query("SELECT seq, project, path FROM revisions WHERE seq > ? ORDER BY seq")
    .all(revisionSeq) as (Located & { seq: number })[];

  const events = db
    .query("SELECT seq, id, project, plan, type, legacy FROM events WHERE seq > ? ORDER BY seq")
    .all(eventSeq) as (EventHead & { seq: number })[];

  const arrived =
    marked.blobs.size === 0
      ? []
      : (db
          .query(
            "SELECT DISTINCT project, path FROM revisions WHERE sha256 IN (SELECT value FROM json_each(?))",
          )
          .all(JSON.stringify([...marked.blobs])) as Located[]);

  const owners = [...marked.owners];
  for (const { project, path } of [...revisions, ...arrived]) {
    const owner = fileOwner(project, path);
    if (owner) owners.push(owner);
  }

  for (const event of events)
    if (event.type !== "revision" || event.legacy === 1) {
      const owner = ownerOfEvent(db, event);
      if (owner) owners.push(owner);
    }

  if (owners.length > 0) refresh(db, owners);
  if (revisions.length > 0) setState(db, "revision_seq", revisions.at(-1)!.seq);
  if (events.length > 0) setState(db, "event_seq", events.at(-1)!.seq);
}

export type StatusWorld = {
  rows: ReadonlyMap<string, ReadonlyMap<string, IndexRow>>;
  issues: readonly Issue[];
};

export function recallStatus(
  document: Pick<RecallDocument, "project" | "ref" | "path" | "slug">,
  world: StatusWorld,
): string {
  const { project, ref, path, slug } = document;
  if (path === ISSUE_PATH) {
    const issue = world.issues.find(
      (each) => each.project === project && issuePlan(each.n) === ref,
    );

    return issue?.state.kind ?? "-";
  }

  if (path !== TRAIL_PATH && isCtx(ref)) return "ctx";
  if (ref === AD_HOC_ID) return "-";

  const rows = [...(world.rows.get(project)?.values() ?? [])];
  const row =
    path === TRAIL_PATH
      ? rows.find((each) => each.id === ref)
      : rows.find((each) => each.id === ref && each.slug === slug);

  return row?.status ?? "-";
}

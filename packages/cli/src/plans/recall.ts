import type { Database } from "bun:sqlite";
import { basename, join, sep } from "node:path";
import {
  AD_HOC_ID,
  eventFrom,
  foldIssues,
  ISSUE_CLOSED,
  ISSUE_FILED,
  issuePlan,
  renumberedFrom,
  ROW_EVENTS,
  STORE_EVENTS,
  type IndexRow,
  type Issue,
} from "skills-core";
import {
  counterparts,
  CTX_FILE,
  EVENT_COLUMNS,
  eventRecord,
  isCopyKey,
  NEWEST_FIRST,
  planOfCopy,
  type EventRow,
} from "./copies.ts";
import { TRAIL_FILE } from "./trail.ts";

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
  filing?: string;
};

export const ISSUE_PATH = "-";

const FILINGS = "issue_filings";

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

export function filingOfOwner(owner: string): string | undefined {
  const [kind, , , filing] = owner.split("\t");
  return kind === "issue" ? filing : undefined;
}

function iso(time: number | string): string {
  return new Date(time).toISOString();
}

function fileOwner(project: string, path: string): Owner | undefined {
  if (!isCopyKey(path) || path.split(sep)[0] !== project) return undefined;
  return { kind: "file", project, name: basename(path) };
}

type NewestCopy = { path: string; captured: string; bytes: Uint8Array | null };

function fileDocuments(db: Database, project: string, name: string): RecallDocument[] {
  const paths = counterparts(join(project, name)).filter(isCopyKey);

  const newest = db
    .query(
      `SELECT r.path, r.captured, b.bytes,
         e.wall AS wall, e.counter AS counter, e.machine AS machine, e.id AS id
       FROM revisions r
       JOIN events e ON e.id = r.event AND e.quarantined IS NULL
       LEFT JOIN blobs b ON b.sha256 = r.sha256
       WHERE r.path IN (SELECT value FROM json_each(?))
       ORDER BY ${NEWEST_FIRST} LIMIT 1`,
    )
    .get(JSON.stringify(paths)) as NewestCopy | null;

  if (!newest?.bytes) return [];

  const stem = basename(name, ".md");
  const ref = planOfCopy(name);
  const slug = CTX_FILE.test(name) ? stem : stem.slice(4);
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

function trailDocuments(db: Database, id: string): RecallDocument[] {
  const row = db
    .query(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = ? AND quarantined IS NULL`)
    .get(id) as EventRow | null;

  if (!row) return [];

  const event = eventFrom(eventRecord(row));
  if (event.kind !== "trail" || event.detail === "") return [];

  return [
    {
      slug: "",
      section: "trail",
      body: event.detail,
      project: event.project,
      ref: event.plan,
      path: TRAIL_FILE,
      recorded: iso(event.wall),
    },
  ];
}

type Numbers = Map<string, { issue: Issue; recorded: string }>;

function issueNumbers(db: Database, project: string): Numbers {
  const rows = db
    .query(
      `SELECT ${EVENT_COLUMNS} FROM events
       WHERE project = ? AND type IN (?, ?) AND legacy = 0 AND quarantined IS NULL
       ORDER BY wall, counter, machine, id`,
    )
    .all(project, ISSUE_FILED, ISSUE_CLOSED) as EventRow[];

  const walls = new Map<string, number>();
  for (const row of rows) walls.set(row.plan, Math.max(walls.get(row.plan) ?? 0, row.wall));

  const issues = foldIssues(rows.map((row) => eventFrom(eventRecord(row))));
  return new Map(
    issues.map((issue) => {
      const plan = issuePlan(issue.n);
      return [plan, { issue, recorded: iso(walls.get(plan)!) }];
    }),
  );
}

function issueDocuments(numbers: Numbers, project: string, plan: string): RecallDocument[] {
  const number = numbers.get(plan);
  if (!number) return [];

  const { issue, recorded } = number;
  return [issue, ...issue.rivals].map((filing) => ({
    slug: "",
    section: "issue",
    body: filing.body === null ? filing.title : `${filing.title}\n\n${filing.body}`,
    project,
    ref: plan,
    path: ISSUE_PATH,
    recorded,
    filing: filing.id,
  }));
}

function documentsOf(db: Database, owner: Owner, folded: Map<string, Numbers>): RecallDocument[] {
  try {
    if (owner.kind === "trail") return trailDocuments(db, owner.id);
    if (owner.kind === "issue") {
      const numbers = folded.get(owner.project) ?? issueNumbers(db, owner.project);
      folded.set(owner.project, numbers);
      return issueDocuments(numbers, owner.project, owner.plan);
    }

    return fileDocuments(db, owner.project, owner.name);
  } catch {
    return [];
  }
}

function refresh(db: Database, owners: Iterable<Owner>): void {
  const byKey = new Map([...owners].map((owner) => [ownerKey(owner), owner]));
  const folded = new Map<string, Numbers>();
  for (const [key, owner] of byKey) {
    const filings = owner.kind === "issue";
    const owned = filings ? "owner = ?1 OR (owner >= ?2 AND owner < ?3)" : "owner = ?1";
    const bounds = filings ? [key, `${key}\t`, `${key}\n`] : [key];
    const stale = db.query(`SELECT id FROM recall_docs WHERE ${owned}`).all(...bounds) as {
      id: number;
    }[];

    for (const { id } of stale) {
      db.run("DELETE FROM recall WHERE rowid = ?", [id]);
      db.run("DELETE FROM recall_trigram WHERE rowid = ?", [id]);
    }

    db.run(`DELETE FROM recall_docs WHERE ${owned}`, bounds);

    for (const document of documentsOf(db, owner, folded)) {
      const { id } = db
        .query("INSERT INTO recall_docs (owner) VALUES (?) RETURNING id")
        .get(document.filing === undefined ? key : `${key}\t${document.filing}`) as { id: number };

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

type EventHead = {
  id: string;
  project: string;
  plan: string;
  type: string;
  legacy: number;
  payload: string;
};

const HEAD = "id, project, plan, type, legacy, payload";

function movedFrom(db: Database, event: EventHead): Owner[] {
  const moved = renumberedFrom(JSON.parse(event.payload));
  if (moved === undefined) return [];

  const left = db
    .query("SELECT plan FROM events WHERE id = ? AND project = ? AND type = ? AND legacy = 0")
    .get(moved, event.project, ISSUE_FILED) as { plan: string } | null;

  return left ? [{ kind: "issue", project: event.project, plan: left.plan }] : [];
}

function ownersOfEvent(db: Database, event: EventHead): Owner[] {
  if (event.type === "revision" && event.legacy === 0) {
    const revision = db
      .query("SELECT project, path FROM revisions WHERE event = ?")
      .get(event.id) as { project: string; path: string } | null;

    const owner = revision && fileOwner(revision.project, revision.path);
    return owner ? [owner] : [];
  }

  if ((event.type === ISSUE_FILED || event.type === ISSUE_CLOSED) && event.legacy === 0) {
    const own: Owner = { kind: "issue", project: event.project, plan: event.plan };
    return event.type === ISSUE_FILED ? [own, ...movedFrom(db, event)] : [own];
  }

  if (event.legacy === 1 || !NOT_TRAIL.has(event.type)) return [{ kind: "trail", id: event.id }];

  return [];
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
    const event = db.query(`SELECT ${HEAD} FROM events WHERE id = ?`).get(id) as EventHead | null;
    if (event) owners.push(...ownersOfEvent(db, event));
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
    newest("revisions") > stateOf(db, "revision_seq") ||
    newest("events") > stateOf(db, "event_seq") ||
    stateOf(db, FILINGS) === 0
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
    .query(`SELECT seq, ${HEAD} FROM events WHERE seq > ? ORDER BY seq`)
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
    if (event.type !== "revision" || event.legacy === 1) owners.push(...ownersOfEvent(db, event));

  const caughtUp = stateOf(db, FILINGS) === 1;
  if (!caughtUp) {
    const numbers = db
      .query("SELECT DISTINCT project, plan FROM events WHERE type = ? AND legacy = 0")
      .all(ISSUE_FILED) as { project: string; plan: string }[];

    for (const { project, plan } of numbers) owners.push({ kind: "issue", project, plan });
  }

  if (owners.length > 0) refresh(db, owners);
  if (revisions.length > 0) setState(db, "revision_seq", revisions.at(-1)!.seq);
  if (events.length > 0) setState(db, "event_seq", events.at(-1)!.seq);
  if (!caughtUp) setState(db, FILINGS, 1);
}

export type StatusWorld = {
  rows: ReadonlyMap<string, ReadonlyMap<string, IndexRow>>;
  issues: readonly Issue[];
};

export function recallStatus(
  document: Pick<RecallDocument, "project" | "ref" | "path" | "slug" | "filing">,
  world: StatusWorld,
): string {
  const { project, ref, path, slug, filing } = document;
  if (path === ISSUE_PATH) {
    const issue = world.issues.find(
      (each) => each.project === project && issuePlan(each.n) === ref,
    );

    const filings = issue ? [issue, ...issue.rivals] : [];
    const own = filing === undefined ? issue : filings.find((each) => each.id === filing);
    return own?.state.kind ?? "-";
  }

  if (path !== TRAIL_FILE && CTX_FILE.test(basename(path))) return "ctx";
  if (ref === AD_HOC_ID) return "-";

  const rows = [...(world.rows.get(project)?.values() ?? [])];
  const row =
    path === TRAIL_FILE
      ? rows.find((each) => each.id === ref)
      : rows.find((each) => each.id === ref && each.slug === slug);

  return row?.status ?? "-";
}

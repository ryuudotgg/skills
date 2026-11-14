import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AD_HOC_ID,
  secondStamp,
  SESSION_EVENT,
  SESSION_STATS_EVENT,
  type Host,
  type SessionRecord,
} from "skills-core";
import { tryLock } from "../lock.ts";
import { openPlansStore } from "../plans/commit.ts";
import { Refusal } from "../plans/import.ts";
import { placed, plansOn } from "../plans/record.ts";
import { appendEvent, sha256, write, type Store } from "../plans/store.ts";
import {
  ensureLinks,
  projectPolicies,
  readLinks,
  saveLink,
  SCAN_DB,
  sessionKey,
  silenced,
  silencedSessions,
} from "./policy.ts";
import {
  advance,
  claudeTranscripts,
  codexTranscripts,
  foldStats,
  type HostDirs,
  type FileState,
  type Progress,
  type ProgressRow,
  recordedIdentity,
  savedIdentity,
  type Seen,
  type Transcript,
} from "./transcripts.ts";

export type ScanResult = { scanned: number; changed: number };

const PROGRESS_VERSION = 1;

const FLUSH_SIZE = 256 * 1024 * 1024;

type Head = { project: string | null; plan: string | null; stats: string | null };

type Scan = {
  store: Store;
  progress: Database;
  root: string;
  files: Map<string, Progress>;
  heads: Map<string, Head>;
  seq: number;
  origins: Map<string, Promise<Origin>>;
  quiet: Set<string>;
  scanned: Set<string>;
  changed: Set<string>;
  dirty: Set<string>;
  replaced: Map<string, string>;
};

type Origin = { project: string; plans: string[]; branch: string };

function openProgress(root: string): Database {
  const db = new Database(join(root, SCAN_DB), { create: true, strict: true });
  try {
    db.run("PRAGMA busy_timeout = 10000");
    db.run("PRAGMA journal_mode = WAL");

    const { user_version: version } = db.query("PRAGMA user_version").get() as {
      user_version: number;
    };

    if (version > PROGRESS_VERSION)
      throw new Refusal(`sessions-scan.db schema ${version} is newer than this release`);

    db.run(`CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      session TEXT NOT NULL,
      subagent INTEGER NOT NULL,
      offset INTEGER NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      head TEXT NOT NULL,
      state TEXT NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS heads (
      key TEXT PRIMARY KEY,
      project TEXT,
      plan TEXT,
      stats TEXT
    )`);

    db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    ensureLinks(db);
    db.run(`PRAGMA user_version = ${PROGRESS_VERSION}`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function meta(db: Database, key: string): string | undefined {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as {
    value: string;
  } | null;

  return row?.value;
}

function forStore(db: Database, store: Store): void {
  if (meta(db, "store") === store.machine) return;

  db.transaction(() => {
    db.run("DELETE FROM files");
    db.run("DELETE FROM heads");
    db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('store', ?), ('seq', '0')", [
      store.machine,
    ]);
  }).immediate();
}

function loadProgress(db: Database): Map<string, Progress> {
  const rows = db
    .query("SELECT path, host, session, subagent, offset, mtime, size, head, state FROM files")
    .all() as ProgressRow[];

  return new Map(
    rows.map((row) => [
      row.path,
      { ...row, subagent: row.subagent === 1, state: JSON.parse(row.state) as FileState },
    ]),
  );
}

function loadHeads(db: Database): Map<string, Head> {
  const rows = db.query("SELECT key, project, plan, stats FROM heads").all() as (Head & {
    key: string;
  })[];

  return new Map(rows.map(({ key, ...head }) => [key, head]));
}

function refreshHeads(scan: Scan): void {
  const rows = scan.store.db
    .query(
      `SELECT seq, type, project, plan, payload FROM events
       WHERE seq > ? AND type IN (?, ?) AND legacy = 0 ORDER BY seq`,
    )
    .all(scan.seq, SESSION_EVENT, SESSION_STATS_EVENT) as {
    seq: number;
    type: string;
    project: string;
    plan: string;
    payload: string;
  }[];

  for (const row of rows) {
    const { host, session } = JSON.parse(row.payload) as { host: Host; session: string };
    const key = sessionKey(host, session);
    const head = scan.heads.get(key) ?? { project: null, plan: null, stats: null };
    if (row.type === SESSION_EVENT)
      scan.heads.set(key, { project: row.project, plan: row.plan, stats: head.stats });
    else scan.heads.set(key, { ...head, stats: sha256(row.payload) });

    scan.dirty.add(key);

    scan.seq = row.seq;
  }
}

function saveProgress(scan: Scan, files: readonly Progress[]): void {
  const { progress: db } = scan;
  const file = db.prepare(
    `INSERT INTO files (path, host, session, subagent, offset, mtime, size, head, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (path) DO UPDATE SET host = excluded.host, session = excluded.session,
       subagent = excluded.subagent, offset = excluded.offset, mtime = excluded.mtime,
       size = excluded.size, head = excluded.head, state = excluded.state`,
  );

  const head = db.prepare(
    "INSERT OR REPLACE INTO heads (key, project, plan, stats) VALUES (?, ?, ?, ?)",
  );

  const gone = db.prepare("DELETE FROM files WHERE path = ?");

  db.transaction(() => {
    for (const each of files) {
      const old = scan.replaced.get(each.path);
      if (old !== undefined) gone.run(old);

      file.run(
        each.path,
        each.host,
        each.session,
        each.subagent ? 1 : 0,
        each.offset,
        each.mtime,
        each.size,
        each.head,
        JSON.stringify(each.state),
      );
    }

    for (const key of scan.dirty) {
      const known = scan.heads.get(key);
      if (known) head.run(key, known.project, known.plan, known.stats);
    }

    db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('seq', ?)", [String(scan.seq)]);
  }).immediate();
}

async function originOf(store: Store, root: string, seen: Seen): Promise<Origin> {
  const branch = seen.branch ?? AD_HOC_ID;
  const cwd = seen.cwd;
  if (cwd === null || !existsSync(cwd)) return { project: AD_HOC_ID, plans: [], branch };

  const where = await placed(root, { cwd, branch: seen.branch ?? "" });
  const linked = store.db
    .transaction(() => plansOn(store, where.project, seen.branch ?? undefined))
    .deferred();

  return { project: where.project, plans: linked.filter((id) => id !== AD_HOC_ID), branch };
}

async function flush(scan: Scan, moved: readonly Progress[]): Promise<void> {
  if (!moved.length) return;

  const { store } = scan;
  const touched = new Set(moved.map((file) => sessionKey(file.host, file.session)));
  const bySession = new Map<string, Progress[]>();
  for (const file of scan.files.values()) {
    const key = sessionKey(file.host, file.session);
    if (touched.has(key)) bySession.set(key, [...(bySession.get(key) ?? []), file]);
  }

  store.db.transaction(() => refreshHeads(scan)).deferred();

  const origins = new Map<string, Origin>();
  for (const [key, files] of bySession) {
    if (scan.heads.get(key)?.project != null) continue;

    const { seen } = (files.find((file) => !file.subagent) ?? files[0]!).state;
    if (seen.cwd === null) continue;

    const cached = `${seen.cwd}\t${seen.branch}`;
    if (!scan.origins.has(cached)) scan.origins.set(cached, originOf(store, scan.root, seen));
    origins.set(key, await scan.origins.get(cached)!);
  }

  const withheld = new Set<string>();
  const links = new Map<string, string>();
  write(store, () => {
    refreshHeads(scan);

    const policies = projectPolicies(store);
    scan.quiet = silencedSessions(store, policies, readLinks(scan.progress));
    const now = Date.now();
    for (const [key, files] of bySession) {
      if (scan.quiet.has(key)) {
        withheld.add(key);
        continue;
      }

      const origin = origins.get(key);
      const fresh = scan.heads.get(key)?.project == null;
      if (fresh && origin && silenced(policies, [origin.project])) {
        withheld.add(key);
        links.set(key, origin.project);
        continue;
      }

      const { host, session } = files[0]!;
      const stats = foldStats(host, session, files);
      if (origin && fresh) {
        const record: SessionRecord = {
          host,
          session,
          branch: origin.branch,
          plans: origin.plans,
          source: "scan",
          started: stats.start ?? secondStamp(now),
        };

        appendEvent(store, {
          kind: "stored",
          type: SESSION_EVENT,
          at: now,
          project: origin.project,
          plan: origin.plans[0] ?? AD_HOC_ID,
          payload: record,
        });

        refreshHeads(scan);
      }

      const head = scan.heads.get(key);
      if (head?.stats === sha256(JSON.stringify(stats))) continue;

      appendEvent(store, {
        kind: "stored",
        type: SESSION_STATS_EVENT,
        at: now,
        project: head?.project ?? AD_HOC_ID,
        plan: head?.plan ?? AD_HOC_ID,
        payload: stats,
      });

      refreshHeads(scan);
      scan.changed.add(key);
    }
  });

  scan.progress
    .transaction(() => {
      for (const [key, project] of links) saveLink(scan.progress, key, project);
    })
    .immediate();

  saveProgress(
    scan,
    moved.filter((file) => !withheld.has(sessionKey(file.host, file.session))),
  );

  for (const key of links.keys()) scan.quiet.add(key);
  scan.dirty.clear();
}

export async function scanSessions(
  root: string,
  dirs: HostDirs,
  deadline = Number.POSITIVE_INFINITY,
): Promise<ScanResult> {
  const lock = await tryLock(join(root, ".sessions.lock"), async () => {
    const store = await openPlansStore(root);
    try {
      const progress = openProgress(root);
      try {
        return await scanInto(store, progress, root, dirs, deadline);
      } finally {
        progress.close();
      }
    } finally {
      store.db.close();
    }
  });

  if (lock.held) throw new Refusal("another sessions scan is running");
  return lock.value;
}

type Orphans = Map<Host, Map<string, Progress | null>>;

function orphansOf(
  files: ReadonlyMap<string, Progress>,
  transcripts: readonly Transcript[],
): Orphans {
  const found = new Set(transcripts.map((transcript) => transcript.path));
  const orphans: Orphans = new Map();
  for (const file of files.values()) {
    const key = found.has(file.path) ? null : savedIdentity(file);
    if (key === null) continue;

    const own = orphans.get(file.host) ?? new Map<string, Progress | null>();
    own.set(key, own.has(key) ? null : file);
    orphans.set(file.host, own);
  }

  return orphans;
}

function successor(orphans: Orphans, transcript: Transcript): Progress | undefined {
  const own = orphans.get(transcript.host);
  if (!own?.size) return undefined;

  const key = recordedIdentity(transcript);
  if (key === null) return undefined;

  const orphan = own.get(key);
  own.delete(key);
  return orphan ?? undefined;
}

async function scanInto(
  store: Store,
  progress: Database,
  root: string,
  dirs: HostDirs,
  deadline: number,
): Promise<ScanResult> {
  forStore(progress, store);

  const scan: Scan = {
    store,
    progress,
    root,
    files: loadProgress(progress),
    heads: loadHeads(progress),
    seq: Number(meta(progress, "seq") ?? 0),
    origins: new Map(),
    quiet: store.db
      .transaction(() => silencedSessions(store, projectPolicies(store), readLinks(progress)))
      .deferred(),
    scanned: new Set(),
    changed: new Set(),
    dirty: new Set(),
    replaced: new Map(),
  };

  const quiet = (identity: Transcript) =>
    scan.quiet.has(sessionKey(identity.host, identity.session));

  const transcripts = [...claudeTranscripts(dirs.claude), ...codexTranscripts(dirs.codex)];
  const orphans = orphansOf(scan.files, transcripts);

  let moved: Progress[] = [];
  let size = 0;
  for (const transcript of transcripts) {
    if (Date.now() > deadline) break;
    if (transcript.host === "claude" && quiet(transcript)) continue;

    const known = scan.files.get(transcript.path) ?? successor(orphans, transcript);
    const next = advance(transcript, known, quiet);
    if (!next) continue;

    if (known && known.path !== next.path) {
      scan.files.delete(known.path);
      scan.replaced.set(next.path, known.path);
    }

    size += next.size;
    moved.push(next);
    scan.files.set(next.path, next);
    scan.scanned.add(sessionKey(next.host, next.session));
    if (size < FLUSH_SIZE) continue;

    await flush(scan, moved);
    moved = [];
    size = 0;
  }

  await flush(scan, moved);
  return { scanned: scan.scanned.size, changed: scan.changed.size };
}

import { basename, isAbsolute, join, sep } from "node:path";
import { CHUNK_SIZE, eventFrom, trailEntry, type EventRecord, type PlanEvent } from "skills-core";
import { commitEvents, indexOf, TRAIL, type Touch } from "./commit.ts";
import { FILE_PLAN, IGNORE_FILE } from "./ignore.ts";
import { markRecallEvents } from "./recall.ts";
import {
  insertFileRevision,
  insertRevision,
  isCopyKey,
  fetchableLocator,
  isDeleted,
  openReadOnly,
  sha256,
  storeBlob,
  type FileRevision,
  type Revision,
  type Store,
} from "./store.ts";

export type RemoteRecord = EventRecord & { id: string };

export type AuthoredEvent = {
  id: string;
  author: string;
  sequence: number;
  previous: string;
  signature: Uint8Array;
  envelope: Uint8Array;
};

export type RemoteBlob = { event: string; sha256: string; bytes: Uint8Array };

export type RemoteBatch = {
  events: readonly AuthoredEvent[];
  blobs: readonly RemoteBlob[];
  meta?: Partial<SyncMeta>;
  recheck?: boolean;
};

export type Cutoff = { sequence: number; hash: string };

export type Verifier = {
  open(event: AuthoredEvent): Promise<RemoteRecord | undefined>;
  cutoff(author: string): Cutoff | undefined;
};

export const QUARANTINES = ["signature", "malformed", "sequence", "chain", "revoked"] as const;

export type Quarantine = (typeof QUARANTINES)[number];

export type Applied = {
  applied: number;
  skipped: number;
  quarantined: Record<Quarantine, number>;
  blobs: number;
  refused: string[];
  queued: number;
  refusedPaths: RefusedPath[];
};

export type RefusedPath = { path: string; reason: string };

type Stored = {
  id: string;
  author: string;
  sequence: number;
  previous: string;
  envelope: Uint8Array;
  quarantined: Quarantine | null;
};

type Opened = AuthoredEvent & { record: RemoteRecord | undefined };

const SHA256 = /^[0-9a-f]{64}$/;

const LOCATOR = /^[0-9a-f]{32}$/;

function field(payload: unknown, name: string): unknown {
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)[name]
    : undefined;
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

const LAST_WALL = 2 ** 48 - 1;

const ROOT_FILES = new Set(["plans.db", "log.tsv", "index.tsv", "done"]);

function isNameCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return code > 0x1f && code !== 0x7f && character !== "/" && character !== "\\";
}

function isName(part: string): boolean {
  return part !== "" && part !== "." && part !== ".." && [...part].every(isNameCharacter);
}

function isProject(name: unknown): name is string {
  if (typeof name !== "string" || !isName(name) || name.startsWith(".")) return false;
  return !ROOT_FILES.has(name) && !name.startsWith("plans.db");
}

function isInside(path: string, project: string): boolean {
  const parts = path.split(sep);
  if (isAbsolute(path) || parts[0] !== project || parts.length < 2) return false;
  return parts.every(isName);
}

export const FIRST_PREVIOUS = "0".repeat(64);

const AUTHOR = /^[0-9a-f]{32}$/;

const EVENT_ID = /^[\x21-\x7e]{1,255}$/;

export function authoredHash(event: Omit<AuthoredEvent, "signature">): string {
  const header = `${event.id}\n${event.author}\n${event.sequence}\n${event.previous}\n`;
  return new Bun.CryptoHasher("sha256").update(header).update(event.envelope).digest("hex");
}

function isHeader(event: AuthoredEvent): boolean {
  const { id, author, sequence, previous } = event;
  if (typeof id !== "string" || !EVENT_ID.test(id)) return false;
  if (typeof author !== "string" || !AUTHOR.test(author)) return false;
  if (!Number.isSafeInteger(sequence) || sequence < 1) return false;
  if (typeof previous !== "string" || !SHA256.test(previous)) return false;

  return (previous === FIRST_PREVIOUS) === (sequence === 1);
}

export function revisionOf(record: RemoteRecord): Revision | undefined {
  const [path, digest, captured, size, locator] = [
    "path",
    "sha256",
    "captured",
    "size",
    "blob",
  ].map((name) => field(record.payload, name));

  if (typeof path !== "string" || !isInside(path, record.project)) return undefined;
  if (typeof digest !== "string" || !SHA256.test(digest)) return undefined;
  if (typeof captured !== "string" || !Number.isFinite(Date.parse(captured))) return undefined;
  if (!isCount(size) || typeof locator !== "string" || !LOCATOR.test(locator)) return undefined;

  return {
    event: record.id,
    project: record.project,
    path,
    sha256: digest,
    captured,
    machine: record.machine,
    size,
    locator,
  };
}

export function chunkSize(size: number, position: number): number {
  return Math.min(CHUNK_SIZE, size - position * CHUNK_SIZE);
}

function chunksOf(value: unknown, size: number): FileRevision["chunks"] | undefined {
  if (!Array.isArray(value) || value.length !== Math.ceil(size / CHUNK_SIZE)) return undefined;

  const chunks: FileRevision["chunks"] = [];
  for (const chunk of value) {
    const [digest, locator] = [field(chunk, "sha256"), field(chunk, "blob")];
    if (typeof digest !== "string" || !SHA256.test(digest)) return undefined;
    if (typeof locator !== "string" || !LOCATOR.test(locator)) return undefined;

    chunks.push({ sha256: digest, locator });
  }

  return chunks;
}

function isReserved(path: string, project: string): boolean {
  return isCopyKey(path) || path === join(project, "index.tsv") || basename(path) === IGNORE_FILE;
}

function isFilePath(path: unknown, project: string): path is string {
  return typeof path === "string" && isInside(path, project) && !isReserved(path, project);
}

function fileRevisionOf(record: RemoteRecord): FileRevision | undefined {
  const { payload } = record;
  const [path, digest, captured, size, executable] = [
    "path",
    "sha256",
    "captured",
    "size",
    "executable",
  ].map((name) => field(payload, name));

  if (record.plan !== FILE_PLAN || !isFilePath(path, record.project)) return undefined;
  if (typeof digest !== "string" || !SHA256.test(digest)) return undefined;
  if (typeof captured !== "string" || !Number.isFinite(Date.parse(captured))) return undefined;
  if (!isCount(size) || typeof executable !== "boolean") return undefined;

  const chunks = chunksOf(field(payload, "chunks"), size);
  if (chunks === undefined) return undefined;

  const parent = field(payload, "parent");
  if (parent !== undefined && (typeof parent !== "string" || !EVENT_ID.test(parent)))
    return undefined;

  return {
    event: record.id,
    project: record.project,
    path,
    sha256: digest,
    size,
    executable,
    captured,
    machine: record.machine,
    chunks,
  };
}

function isFileRevision(record: Pick<EventRecord, "type" | "payload">): boolean {
  return record.type === "revision" && field(record.payload, "chunks") !== undefined;
}

function deletedBlob(record: Pick<EventRecord, "type" | "payload">): string | undefined {
  if (record.type !== "blob-deleted") return undefined;
  const blob = field(record.payload, "blob");
  return typeof blob === "string" && LOCATOR.test(blob) ? blob : undefined;
}

export function indexRevision(store: Store, record: RemoteRecord): void {
  if (record.type !== "revision") return;

  if (isFileRevision(record)) {
    const file = fileRevisionOf(record);
    if (file) insertFileRevision(store, file);
    return;
  }

  const revision = revisionOf(record);
  if (revision) insertRevision(store, revision);
}

function isOneLine(value: string): boolean {
  return !/[\r\n]/.test(value);
}

function isCanonicalLine(record: RemoteRecord, line: string, detail: string): boolean {
  if (record.legacy) return isOneLine(line);

  const fields = { ts: record.ts, project: record.project, id: record.plan, event: record.type };
  const canonical = trailEntry({ ...fields, detail });
  return canonical.line === line && canonical.detail === detail;
}

function decoded(record: RemoteRecord): PlanEvent | undefined {
  const { id, wall, counter, legacy } = record;
  if (typeof id !== "string" || id === "" || !isCount(wall) || !isCount(counter)) return undefined;
  if (wall > LAST_WALL) return undefined;
  if (typeof legacy !== "boolean" || !isProject(record.project)) return undefined;

  for (const name of ["machine", "ts", "plan", "type"] as const)
    if (typeof record[name] !== "string" || record[name] === "") return undefined;

  let event: PlanEvent;
  try {
    event = eventFrom(record);
  } catch {
    return undefined;
  }

  if (event.kind === "trail" && !isCanonicalLine(record, event.line, event.detail))
    return undefined;

  if (event.kind === "stored" && event.type === "revision") {
    const valid = isFileRevision(record) ? fileRevisionOf(record) : revisionOf(record);
    if (!valid) return undefined;
  }

  if (event.kind === "stored" && event.type === "blob-deleted" && !deletedBlob(record))
    return undefined;

  return event;
}

function folding(store: Store, author: string, sequence: number): Stored | undefined {
  const stored = store.db
    .query(
      `SELECT id, author, sequence, previous, envelope, quarantined FROM events
       WHERE author = ? AND sequence = ? AND quarantined IS NULL`,
    )
    .get(author, sequence) as Stored | null;

  return stored ?? undefined;
}

function reasonFor(store: Store, event: Opened): Quarantine | undefined {
  if (!event.record) return "signature";
  if (!isHeader(event) || event.record.id !== event.id || !decoded(event.record))
    return "malformed";

  if (folding(store, event.author, event.sequence)) return "sequence";

  const before = folding(store, event.author, event.sequence - 1);
  if (before && authoredHash(before) !== event.previous) return "chain";

  return undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: unknown): number {
  return isCount(value) ? value : 0;
}

function insertAuthored(store: Store, event: Opened, reason: Quarantine | undefined): void {
  const record: Partial<RemoteRecord> = event.record ?? {};
  store.db.run(
    `INSERT INTO events (id, machine, wall, counter, ts, project, plan, type, legacy, payload,
       author, sequence, previous, signature, envelope, quarantined)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.id,
      text(record.machine),
      count(record.wall),
      count(record.counter),
      text(record.ts),
      text(record.project),
      text(record.plan),
      text(record.type),
      record.legacy === true ? 1 : 0,
      JSON.stringify(record.payload) ?? "null",
      event.author,
      event.sequence,
      event.previous,
      event.signature,
      event.envelope,
      reason ?? null,
    ],
  );

  const opened = reason === "malformed" || reason === "signature" ? undefined : event.record;
  if (opened) indexRevision(store, opened);
}

function committedChain(events: readonly Stored[], cutoff: Cutoff): Set<string> {
  const byLink = new Map<string, Stored>();
  for (const event of events)
    if (event.quarantined !== "signature")
      byLink.set(`${event.sequence}\t${authoredHash(event)}`, event);

  const link = (sequence: number, hash: string) => byLink.get(`${sequence}\t${hash}`);

  const chain = new Set<string>();
  for (let at = link(cutoff.sequence, cutoff.hash); at; at = link(at.sequence - 1, at.previous))
    chain.add(at.id);

  return chain;
}

type Flip = { id: string; reason: Quarantine | null };

function refold(store: Store, author: string, cutoff: Cutoff): Flip[] {
  const events = store.db
    .query(
      "SELECT id, author, sequence, previous, envelope, quarantined FROM events WHERE author = ?",
    )
    .all(author) as Stored[];

  const chain = committedChain(events, cutoff);
  const revoked = (event: Stored) => !chain.has(event.id);

  const revocations: Flip[] = [];
  const restorations: Flip[] = [];
  for (const event of events) {
    if (event.quarantined === "signature" || event.quarantined === "malformed") continue;

    if (revoked(event)) {
      if (event.quarantined !== "revoked") revocations.push({ id: event.id, reason: "revoked" });
    } else if (chain.has(event.id) && event.quarantined !== null)
      restorations.push({ id: event.id, reason: null });
  }

  return [...revocations, ...restorations];
}

function changedCutoffs(
  store: Store,
  cutoffs: ReadonlyMap<string, Cutoff>,
  fresh: readonly Opened[],
) {
  const arriving = new Set(fresh.map((event) => event.author));
  return [...cutoffs].filter(([author, cutoff]) => {
    if (arriving.has(author)) return true;

    const known = store.db
      .query("SELECT sequence, hash FROM cutoffs WHERE author = ?")
      .get(author) as Cutoff | null;

    return known?.sequence !== cutoff.sequence || known.hash !== cutoff.hash;
  });
}

function recordCutoff(store: Store, author: string, cutoff: Cutoff): void {
  store.db.run(
    `INSERT INTO cutoffs (author, sequence, hash) VALUES (?, ?, ?)
     ON CONFLICT (author) DO UPDATE SET sequence = excluded.sequence, hash = excluded.hash`,
    [author, cutoff.sequence, cutoff.hash],
  );
}

type Kept = { record: RemoteRecord; folds: boolean };

function kept(store: Store, id: string): Kept {
  const row = store.db
    .query(
      `SELECT id, machine, wall, counter, ts, project, plan, type, legacy, payload, quarantined
       FROM events WHERE id = ?`,
    )
    .get(id) as Omit<RemoteRecord, "legacy" | "payload"> & {
    legacy: number;
    payload: string;
    quarantined: Quarantine | null;
  };

  const { quarantined, ...fields } = row;
  const record = {
    ...fields,
    legacy: row.legacy === 1,
    payload: JSON.parse(row.payload) as unknown,
  };

  return { record, folds: quarantined === null };
}

function quarantinedAmong(store: Store, ids: ReadonlySet<string>): Record<Quarantine, number> {
  const counts = Object.fromEntries(QUARANTINES.map((reason) => [reason, 0])) as Record<
    Quarantine,
    number
  >;

  const reasons = store.db
    .query(
      `SELECT quarantined FROM events
       WHERE id IN (SELECT value FROM json_each(?)) AND quarantined IS NOT NULL`,
    )
    .all(JSON.stringify([...ids])) as { quarantined: Quarantine }[];

  for (const { quarantined } of reasons) counts[quarantined] += 1;

  return counts;
}

export function touchViews(touch: Touch, record: RemoteRecord): void {
  const event = decoded(record);
  if (event?.kind === "row") touch(indexOf(event.project));
  if (event?.kind === "trail") touch(TRAIL);
}

function storeBlobs(
  store: Store,
  blobs: readonly RemoteBlob[],
): { stored: number; refused: string[] } {
  let stored = 0;
  const refused: string[] = [];
  for (const blob of blobs) {
    const expected = expectedBlob(store, blob);
    const digest = sha256(blob.bytes);
    if (!expected || expected.sha256 !== digest || expected.size !== blob.bytes.byteLength) {
      refused.push(blob.event);
      continue;
    }

    if (storeBlob(store, digest, blob.bytes, expected.locator)) stored += 1;
  }

  return { stored, refused };
}

type Expected = { sha256: string; locator: string; size: number };

function expectedBlob(store: Store, blob: RemoteBlob): Expected | undefined {
  const revision = store.db
    .query(
      `SELECT r.sha256, r.locator, r.size FROM revisions r
       JOIN events e ON e.id = r.event AND e.quarantined IS NULL WHERE r.event = ?`,
    )
    .get(blob.event) as Expected | null;

  if (revision) return revision;

  const chunk = store.db
    .query(
      `SELECT c.sha256, c.locator, c.position, f.size FROM file_chunks c
       JOIN files f ON f.event = c.event
       JOIN events e ON e.id = c.event AND e.quarantined IS NULL
       WHERE c.event = ? AND c.sha256 = ? LIMIT 1`,
    )
    .get(blob.event, blob.sha256) as (Expected & { position: number }) | null;

  return chunk ? { ...chunk, size: chunkSize(chunk.size, chunk.position) } : undefined;
}

function referencesOf(record: RemoteRecord): { sha256: string; locator: string }[] {
  if (record.type !== "revision") return [];
  if (isFileRevision(record)) return fileRevisionOf(record)?.chunks ?? [];

  const revision = revisionOf(record);
  return revision ? [revision] : [];
}

function queueFetch(store: Store, record: RemoteRecord): number {
  let queued = 0;
  for (const reference of referencesOf(record)) {
    const digest = reference.sha256;
    if (store.db.query("SELECT 1 FROM blobs WHERE sha256 = ?").get(digest)) continue;

    const locator = isDeleted(store.db, reference.locator)
      ? fetchableLocator(store.db, digest)
      : reference.locator;

    if (locator === undefined) continue;

    const inserted = store.db.run(
      "INSERT OR IGNORE INTO blob_fetches (sha256, locator, event, queued) VALUES (?, ?, ?, ?)",
      [digest, locator, record.id, Date.now()],
    );

    queued += inserted.changes;
  }

  return queued;
}

function dropDeleted(store: Store, record: RemoteRecord): void {
  const locator = deletedBlob(record);
  if (locator === undefined) return;

  const fetches = store.db
    .query("SELECT sha256 FROM blob_fetches WHERE locator = ?")
    .all(locator) as { sha256: string }[];

  for (const { sha256: digest } of fetches) {
    const alive = fetchableLocator(store.db, digest);
    if (alive === undefined) store.db.run("DELETE FROM blob_fetches WHERE sha256 = ?", [digest]);
    else
      store.db.run("UPDATE blob_fetches SET locator = ?, attempts = 0 WHERE sha256 = ?", [
        alive,
        digest,
      ]);
  }
}

function bySequence(left: AuthoredEvent, right: AuthoredEvent): number {
  if (left.author !== right.author) return left.author < right.author ? -1 : 1;
  return left.sequence - right.sequence;
}

const READMITTED = new Set<Quarantine | null>(["signature", "revoked"]);

const RECHECKED = new Set<Quarantine | null>([...READMITTED, "malformed"]);
function settledIds(root: string, events: readonly AuthoredEvent[], recheck: boolean) {
  if (events.length === 0) return new Set();

  const db = openReadOnly(join(root, "plans.db"));
  try {
    const known = db
      .query("SELECT id, quarantined FROM events WHERE id IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(events.map((event) => event.id))) as {
      id: string;
      quarantined: Quarantine | null;
    }[];

    const readmitted = recheck ? RECHECKED : READMITTED;
    return new Set(known.filter((row) => !readmitted.has(row.quarantined)).map((row) => row.id));
  } finally {
    db.close();
  }
}

function queueLanding(store: Store, record: RemoteRecord): void {
  if (record.type !== "revision") return;
  const valid = isFileRevision(record) ? fileRevisionOf(record) : revisionOf(record);
  if (valid) store.db.run("INSERT OR IGNORE INTO landings (event) VALUES (?)", [record.id]);
}

export async function applyRemoteEvents(
  root: string,
  batch: RemoteBatch,
  verifier: Verifier,
): Promise<Applied> {
  const recheck = batch.recheck === true;
  const settled = settledIds(root, batch.events, recheck);
  const opened: Opened[] = [];
  for (const event of [...batch.events].sort(bySequence))
    if (!settled.has(event.id)) opened.push({ ...event, record: await verifier.open(event) });

  return commitEvents(root, (store, touch) => {
    const fresh = opened.filter((event) => isFresh(store, event, recheck));
    const refolding = changedCutoffs(store, revokedAuthors(store, fresh, verifier), fresh);

    store.db.run("SAVEPOINT probe");

    let visible: RemoteRecord[];
    try {
      visible = foldBatch(store, fresh, refolding, recheck).visible;
    } finally {
      store.db.run("ROLLBACK TO probe");
      store.db.run("RELEASE probe");
    }

    for (const record of visible) touchViews(touch, record);

    const { changed, inserted, refusedPaths } = foldBatch(store, fresh, refolding, recheck);
    markRecallEvents(
      store.db,
      [...changed].filter((id) => !inserted.has(id)),
    );

    const blobs = storeBlobs(store, batch.blobs);

    let queued = 0;
    for (const id of changed) {
      const { record, folds } = kept(store, id);
      if (!folds) continue;

      queued += queueFetch(store, record);
      queueLanding(store, record);
      dropDeleted(store, record);
    }

    if (batch.meta) setSyncMeta(store, batch.meta);

    const quarantined = quarantinedAmong(store, inserted);
    const held = Object.values(quarantined).reduce((sum, count) => sum + count, 0);
    return {
      applied: inserted.size - held,
      skipped: batch.events.length - inserted.size,
      quarantined,
      blobs: blobs.stored,
      refused: blobs.refused,
      queued,
      refusedPaths,
    };
  });
}

type Folded = {
  changed: Set<string>;
  inserted: Set<string>;
  visible: RemoteRecord[];
  refusedPaths: RefusedPath[];
};

function refusedPath(event: Opened, reason: Quarantine | undefined): RefusedPath | undefined {
  const record = event.record;
  if (reason !== "malformed" || record?.type !== "revision") return undefined;

  const path = field(record.payload, "path");
  if (typeof path !== "string") return undefined;
  if (!isInside(path, record.project))
    return { path, reason: "the event names a path outside its project" };

  if (isFileRevision(record) && isReserved(path, record.project))
    return { path, reason: "the event names a file only plan sync writes" };

  return { path, reason: "the event does not validate" };
}

function foldBatch(
  store: Store,
  fresh: readonly Opened[],
  refolding: readonly [string, Cutoff][],
  recheck: boolean,
): Folded {
  const changed = new Set<string>();
  const inserted = new Set<string>();
  const flipped = new Set<string>();
  const refusedPaths: RefusedPath[] = [];
  for (const event of fresh) {
    if (inserted.has(event.id)) continue;

    supersede(store, event.id, recheck);

    const reason = reasonFor(store, event);
    insertAuthored(store, event, reason);
    inserted.add(event.id);
    if (!reason) changed.add(event.id);

    const refused = refusedPath(event, reason);
    if (refused !== undefined) refusedPaths.push(refused);
  }

  for (const [author, cutoff] of refolding) {
    for (const { id, reason } of refold(store, author, cutoff)) {
      store.db.run("UPDATE events SET quarantined = ? WHERE id = ?", [reason, id]);
      changed.add(id);
      if (!inserted.has(id)) flipped.add(id);
    }

    recordCutoff(store, author, cutoff);
  }

  const visible = [...changed].flatMap((id) => {
    const { record, folds } = kept(store, id);
    return folds || flipped.has(id) ? [record] : [];
  });

  return { changed, inserted, visible, refusedPaths };
}

function revokedAuthors(
  store: Store,
  fresh: readonly Opened[],
  verifier: Verifier,
): Map<string, Cutoff> {
  const stored = store.db
    .query("SELECT DISTINCT author FROM events WHERE author IS NOT NULL")
    .all() as { author: string }[];

  const cutoffs = new Map<string, Cutoff>();
  for (const author of new Set([
    ...stored.map((row) => row.author),
    ...fresh.map((e) => e.author),
  ])) {
    const cutoff = verifier.cutoff(author);
    if (cutoff) cutoffs.set(author, cutoff);
  }

  return cutoffs;
}

function isFresh(store: Store, event: Opened, recheck: boolean): boolean {
  const known = store.db
    .query("SELECT id, author, sequence, previous, envelope, quarantined FROM events WHERE id = ?")
    .get(event.id) as Stored | null;

  if (!known) return true;
  if (!event.record || !isHeader(event)) return false;
  if (known.quarantined === "signature") return true;
  if (recheck && known.quarantined === "malformed") return true;

  return known.quarantined === "revoked" && authoredHash(known) !== authoredHash(event);
}

function supersede(store: Store, id: string, recheck: boolean): void {
  const known = store.db.query("SELECT seq, quarantined FROM events WHERE id = ?").get(id) as {
    seq: number;
    quarantined: Quarantine | null;
  } | null;

  if (!known || !(recheck ? RECHECKED : READMITTED).has(known.quarantined)) return;

  const kept = `${id}/superseded/${known.seq}`;
  store.db.run("UPDATE events SET id = ? WHERE seq = ?", [kept, known.seq]);

  for (const table of ["revisions", "files", "file_chunks"])
    store.db.run(`UPDATE ${table} SET event = ? WHERE event = ?`, [kept, id]);
}

export type Checkpoint = { fingerprint: string; head: string; length: number; epoch: number };

export type SyncMeta = {
  device?: string;
  sequence: number;
  pushed: number;
  pulled: number;
  pulledId?: string;
  incarnation?: string;
  checkpoint?: Checkpoint;
};

const META_KEYS = {
  device: "device",
  sequence: "sequence",
  pushed: "pushed",
  pulled: "pulled",
  pulledId: "pulled_id",
  incarnation: "incarnation",
  checkpoint: "checkpoint",
} as const satisfies Record<keyof SyncMeta, string>;

function metaValue(store: Store, key: string): string | undefined {
  const row = store.db.query("SELECT value FROM meta WHERE key = ?").get(key) as {
    value: string;
  } | null;

  return row?.value;
}

export function syncMeta(store: Store): SyncMeta {
  const number = (key: string) => Number(metaValue(store, key) ?? 0);
  const checkpoint = metaValue(store, META_KEYS.checkpoint);
  return {
    device: metaValue(store, META_KEYS.device),
    sequence: number(META_KEYS.sequence),
    pushed: number(META_KEYS.pushed),
    pulled: number(META_KEYS.pulled),
    pulledId: metaValue(store, META_KEYS.pulledId),
    incarnation: metaValue(store, META_KEYS.incarnation),
    checkpoint: checkpoint === undefined ? undefined : (JSON.parse(checkpoint) as Checkpoint),
  };
}

export function setSyncMeta(store: Store, patch: Partial<SyncMeta>): void {
  for (const [name, value] of Object.entries(patch)) {
    if (value === undefined) continue;

    const key = META_KEYS[name as keyof SyncMeta];
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    store.db.run(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [key, text],
    );
  }
}

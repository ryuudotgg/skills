import { hex, type Membership } from "skills-core";
import { appendEvent, RECORDED_HERE, write, type Store } from "./store.ts";
import { commitEvents } from "./commit.ts";
import {
  authoredHash,
  FIRST_PREVIOUS,
  indexRevision,
  touchViews,
  syncMeta,
  type AuthoredEvent,
  type RemoteRecord,
} from "./sync.ts";

export type Unsealed = { readonly seq: number; readonly record: RemoteRecord };

export type Sealed = AuthoredEvent & { readonly seq: number };

export type Tail = { readonly sequence: number; readonly hash: string };

export type Held = { readonly device: string; readonly through: number };

export type Stopped = { readonly device: string; readonly reason: string };

export type Counts = {
  readonly queue: number;
  readonly quarantined: number;
  readonly fetching: number;
  readonly history: number;
  readonly conflicts: number;
  readonly transcripts: { readonly pending: number; readonly withheld: number };
};

const KEYS = {
  seen: "hub_seen",
  held: "hub_held",
  stopped: "hub_stopped",
  synced: "hub_synced",
  reconciled: "hub_reconciled",
  reconcile: "hub_reconcile",
  rechecked: "hub_rechecked",
} as const;

type Key = keyof typeof KEYS;

const UNSENT =
  "author IS NULL AND quarantined IS NULL AND withheld IS NULL AND type <> 'copy-conflict'";

function readMeta(store: Store, key: Key): string | undefined {
  const row = store.db.query("SELECT value FROM meta WHERE key = ?").get(KEYS[key]) as {
    value: string;
  } | null;

  return row?.value;
}

function writeMeta(store: Store, key: Key, value: string | undefined): void {
  if (value === undefined) store.db.run("DELETE FROM meta WHERE key = ?", [KEYS[key]]);
  else
    store.db.run(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [KEYS[key], value],
    );
}

function json<T>(store: Store, key: Key): T | undefined {
  const value = readMeta(store, key);
  return value === undefined ? undefined : (JSON.parse(value) as T);
}

export function seen(store: Store): number {
  return Number(readMeta(store, "seen") ?? 0);
}

export function markSeen(store: Store, length: number): void {
  write(store, () => writeMeta(store, "seen", String(length)));
}

export function held(store: Store): Held | undefined {
  return json<Held>(store, "held");
}

export function hold(store: Store, device: string): void {
  write(store, () => {
    const { through } = store.db
      .query("SELECT coalesce(max(seq), 0) AS through FROM events")
      .get() as {
      through: number;
    };

    const earlier = held(store)?.device ?? device;
    writeMeta(store, "held", JSON.stringify({ device: earlier, through }));
  });
}

export function release(store: Store): void {
  write(store, () => writeMeta(store, "held", undefined));
}

export function stopped(store: Store): Stopped | undefined {
  return json<Stopped>(store, "stopped");
}

export function stop(store: Store, stop: Stopped | undefined): void {
  write(store, () => writeMeta(store, "stopped", stop && JSON.stringify(stop)));
}

export function lastSync(store: Store): string | undefined {
  return readMeta(store, "synced");
}

export function reconciledAt(store: Store): string | undefined {
  return readMeta(store, "reconciled");
}

export type Reconcile = {
  readonly incarnation: string;
  readonly heads?: Record<string, number>;
  readonly phase?: "pull";
};

export function reconciling(store: Store): Reconcile | undefined {
  return json<Reconcile>(store, "reconcile");
}

export function setReconcilingIn(store: Store, state: Reconcile | undefined): void {
  writeMeta(store, "reconcile", state && JSON.stringify(state));
}

export function setReconciling(store: Store, state: Reconcile | undefined): void {
  write(store, () => setReconcilingIn(store, state));
}

export function finishSync(store: Store, at: string, reconciled: boolean): void {
  write(store, () => {
    writeMeta(store, "synced", at);

    if (reconciled) {
      writeMeta(store, "reconciled", at);
      writeMeta(store, "reconcile", undefined);
    }
  });
}

type EventRow = Omit<RemoteRecord, "legacy" | "payload"> & {
  seq: number;
  legacy: number;
  payload: string;
};

const RECORD_COLUMNS = "seq, id, machine, wall, counter, ts, project, plan, type, legacy, payload";

function recordOf(row: EventRow): Unsealed {
  const { seq, legacy, payload, ...fields } = row;
  return { seq, record: { ...fields, legacy: legacy === 1, payload: JSON.parse(payload) } };
}

export function unsealed(store: Store, device: string, limit: number): Unsealed[] {
  const mark = held(store);
  const through = mark === undefined ? 0 : mark.through;
  const rows = store.db
    .query(
      `SELECT ${RECORD_COLUMNS} FROM events
       WHERE ${UNSENT} AND seq > ?
       ORDER BY seq LIMIT ?`,
    )
    .all(mark?.device === device ? Number.MAX_SAFE_INTEGER : through, limit) as EventRow[];

  return rows.map(recordOf);
}

export function tailOf(store: Store, device: string): Tail | undefined {
  const row = store.db
    .query(
      `SELECT id, author, sequence, previous, envelope FROM events
       WHERE author = ? AND quarantined IS NULL ORDER BY sequence DESC LIMIT 1`,
    )
    .get(device) as Omit<AuthoredEvent, "signature"> | null;

  return row === null ? undefined : { sequence: row.sequence, hash: authoredHash(row) };
}

export function previousOf(tail: Tail | undefined): string {
  return tail?.hash ?? FIRST_PREVIOUS;
}

export function storeSealed(store: Store, sealed: readonly Sealed[]): void {
  write(store, () => {
    for (const event of sealed) {
      store.db.run(
        `UPDATE events SET author = ?, sequence = ?, previous = ?, signature = ?, envelope = ?
         WHERE seq = ? AND author IS NULL`,
        [event.author, event.sequence, event.previous, event.signature, event.envelope, event.seq],
      );

      const referenced = store.db
        .query(
          `SELECT r.sha256 FROM revisions r JOIN events e ON e.id = r.event
           WHERE e.seq = ? AND e.type = 'revision'
           UNION
           SELECT c.sha256 FROM file_chunks c JOIN events e ON e.id = c.event
           WHERE e.seq = ? AND e.type = 'revision'
           UNION
           SELECT value FROM events e, json_each(json_array(
             json_extract(e.payload, '$.sha256'), json_extract(e.payload, '$.digest')))
           WHERE e.seq = ? AND e.type = 'transcript'`,
        )
        .all(event.seq, event.seq, event.seq) as { sha256: string }[];

      for (const { sha256 } of referenced)
        store.db.run("INSERT OR IGNORE INTO blob_uploads (sha256, queued) VALUES (?, ?)", [
          sha256,
          Date.now(),
        ]);
    }

    const last = sealed.at(-1);
    if (last)
      store.db.run(
        "INSERT INTO meta (key, value) VALUES ('sequence', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        [String(last.sequence)],
      );
  });
}

const TRANSCRIPT_BLOBS = `SELECT value FROM events e, json_each(json_array(
    json_extract(e.payload, '$.sha256'), json_extract(e.payload, '$.digest')))
  WHERE e.type = 'transcript' AND e.quarantined IS NULL`;

function dropUploads(store: Store, digests: readonly string[]): void {
  store.db.run(
    `DELETE FROM blob_uploads WHERE sha256 IN (SELECT value FROM json_each(?))
       AND sha256 NOT IN (${TRANSCRIPT_BLOBS} AND e.author IS NOT NULL AND e.withheld IS NULL)
       AND sha256 NOT IN (SELECT sha256 FROM revisions UNION SELECT sha256 FROM file_chunks)`,
    [JSON.stringify(digests)],
  );
}

export function dropUnsentUploads(store: Store): void {
  const unsent = store.db
    .query(`${TRANSCRIPT_BLOBS} AND (e.author IS NULL OR e.withheld = 1)`)
    .all() as { value: string }[];

  if (unsent.length > 0)
    dropUploads(
      store,
      unsent.map((row) => row.value),
    );
}

export function withhold(store: Store, seqs: readonly number[]): void {
  write(store, () => {
    store.db.run("UPDATE events SET withheld = 1 WHERE seq IN (SELECT value FROM json_each(?))", [
      JSON.stringify(seqs),
    ]);

    dropUnsentUploads(store);
  });
}

export function unacknowledged(store: Store, device: string, limit: number): Sealed[] {
  const { pushed } = syncMeta(store);
  const rows = store.db
    .query(
      `SELECT seq, id, author, sequence, previous, signature, envelope FROM events
       WHERE author = ? AND sequence > ? AND quarantined IS NULL AND envelope IS NOT NULL
       ORDER BY sequence LIMIT ?`,
    )
    .all(device, pushed, limit) as Sealed[];

  return rows.map((row) => ({
    ...row,
    signature: new Uint8Array(row.signature),
    envelope: new Uint8Array(row.envelope),
  }));
}

export type SealedRecord = {
  readonly sequence: number;
  readonly project: string;
  readonly type: string;
  payload: unknown;
};

export function sealedRecords(
  store: Store,
  device: string,
  types: readonly string[],
): SealedRecord[] {
  const rows = store.db
    .query(
      `SELECT sequence, project, type, payload FROM events
       WHERE author = ? AND sequence > ? AND quarantined IS NULL
         AND type IN (SELECT value FROM json_each(?)) ORDER BY sequence`,
    )
    .all(device, syncMeta(store).pushed, JSON.stringify(types)) as {
    sequence: number;
    project: string;
    type: string;
    payload: string;
  }[];

  return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
}

export function acknowledge(store: Store, sequence: number): void {
  write(store, () =>
    store.db.run(
      "INSERT INTO meta (key, value) VALUES ('pushed', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [String(sequence)],
    ),
  );
}

export function unsealAfter(store: Store, device: string, after: number): void {
  write(store, () => {
    store.db.run(
      `UPDATE events SET author = NULL, sequence = NULL, previous = NULL, signature = NULL,
         envelope = NULL
       WHERE author = ? AND sequence > ? AND quarantined IS NULL`,
      [device, after],
    );

    store.db.run(
      "INSERT INTO meta (key, value) VALUES ('pushed', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [String(after)],
    );
  });
}

export type QueuedBlob = {
  readonly sha256: string;
  readonly locator: string;
  readonly bytes: Uint8Array;
};

export function queuedUploads(
  store: Store,
  limit: number,
  bytes: number,
  held: readonly string[] = [],
): QueuedBlob[] {
  const rows = store.db
    .query(
      `SELECT picked.sha256, b.locator, b.bytes FROM (
         SELECT u.sha256, u.queued,
           sum(coalesce(length(b.bytes), 0)) OVER (ORDER BY u.queued, u.sha256) AS running,
           coalesce(length(b.bytes), 0) AS size
         FROM blob_uploads u LEFT JOIN blobs b ON b.sha256 = u.sha256
         WHERE u.sha256 NOT IN (SELECT value FROM json_each(?))
       ) picked LEFT JOIN blobs b ON b.sha256 = picked.sha256
       WHERE picked.running - picked.size < ? ORDER BY picked.queued, picked.sha256 LIMIT ?`,
    )
    .all(JSON.stringify(held), bytes, limit) as {
    sha256: string;
    locator: string | null;
    bytes: Uint8Array | null;
  }[];

  const missing = rows.filter((row) => row.bytes === null).map((row) => row.sha256);
  if (missing.length > 0) uploaded(store, missing);

  return rows.flatMap((row) =>
    row.locator === null || row.bytes === null
      ? []
      : [{ sha256: row.sha256, locator: row.locator, bytes: new Uint8Array(row.bytes) }],
  );
}

export function uploaded(store: Store, digests: readonly string[]): void {
  write(store, () =>
    store.db.run("DELETE FROM blob_uploads WHERE sha256 IN (SELECT value FROM json_each(?))", [
      JSON.stringify(digests),
    ]),
  );
}

const DELETED_LOCATORS = `SELECT json_extract(payload, '$.blob') FROM events
  WHERE type = 'blob-deleted' AND quarantined IS NULL`;

export type Tombstone = { readonly locator: string; readonly event: string };

export function queueDeletion(store: Store, deletion: Tombstone): void {
  store.db.run("INSERT OR IGNORE INTO blob_deletes (event, locator) VALUES (?, ?)", [
    deletion.event,
    deletion.locator,
  ]);
}

export function pendingDeletions(store: Store, device: string): Tombstone[] {
  return store.db
    .query(
      `SELECT d.locator, d.event FROM blob_deletes d JOIN events e ON e.id = d.event
       WHERE e.author = ? AND e.sequence <= ? AND e.quarantined IS NULL ORDER BY e.sequence`,
    )
    .all(device, syncMeta(store).pushed) as Tombstone[];
}

export function deletionSent(store: Store, event: string): void {
  write(store, () => store.db.run("DELETE FROM blob_deletes WHERE event = ?", [event]));
}

export function tombstones(store: Store): Tombstone[] {
  return store.db
    .query(
      `SELECT json_extract(payload, '$.blob') AS locator, id AS event FROM events
       WHERE type = 'blob-deleted' AND quarantined IS NULL AND author IS NOT NULL
       ORDER BY locator`,
    )
    .all() as Tombstone[];
}

export function recheckedFiles(store: Store): boolean {
  return readMeta(store, "rechecked") !== undefined;
}

export function markRecheckedFiles(store: Store): void {
  write(store, () => writeMeta(store, "rechecked", "1"));
}

export function malformedFileEvents(store: Store): AuthoredEvent[] {
  const rows = store.db
    .query(
      `SELECT id, author, sequence, previous, signature, envelope FROM events
       WHERE quarantined = 'malformed' AND type IN ('revision', 'blob-deleted')
         AND envelope IS NOT NULL AND id NOT LIKE '%/superseded/%'
       ORDER BY author, sequence`,
    )
    .all() as AuthoredEvent[];

  return rows.map((row) => ({
    ...row,
    signature: new Uint8Array(row.signature),
    envelope: new Uint8Array(row.envelope),
  }));
}

export type Fetch = { readonly sha256: string; readonly locator: string; readonly event: string };

export function queuedFetches(store: Store, limit: number): Fetch[] {
  return store.db
    .query(
      `SELECT f.sha256, coalesce(live.locator, f.locator) AS locator,
         coalesce(live.event, f.event) AS event
       FROM blob_fetches f
       LEFT JOIN (
         SELECT sha256, locator, event FROM (
           SELECT r.sha256, r.locator, r.event FROM revisions r
           JOIN events e ON e.id = r.event AND e.quarantined IS NULL
           UNION ALL
           SELECT c.sha256, c.locator, c.event FROM file_chunks c
           JOIN events e ON e.id = c.event AND e.quarantined IS NULL
         ) WHERE locator NOT IN (${DELETED_LOCATORS}) GROUP BY sha256
       ) live ON live.sha256 = f.sha256
       ORDER BY f.attempts, f.queued, f.sha256 LIMIT ?`,
    )
    .all(limit) as Fetch[];
}

export function fetchFailed(store: Store, digests: readonly string[]): void {
  write(store, () =>
    store.db.run(
      "UPDATE blob_fetches SET attempts = attempts + 1 WHERE sha256 IN (SELECT value FROM json_each(?))",
      [JSON.stringify(digests)],
    ),
  );
}

export type Reference = { readonly sha256: string; readonly locator: string };

const SENT_TRANSCRIPTS =
  "type = 'transcript' AND author IS NOT NULL AND quarantined IS NULL AND withheld IS NULL";

export function referencedLocators(store: Store): Reference[] {
  return store.db
    .query(
      `SELECT DISTINCT sha256, locator FROM (
         SELECT r.sha256, r.locator FROM revisions r
         JOIN events e ON e.id = r.event AND e.quarantined IS NULL
         UNION ALL
         SELECT c.sha256, c.locator FROM file_chunks c
         JOIN events e ON e.id = c.event AND e.quarantined IS NULL
         UNION ALL
         SELECT json_extract(payload, '$.sha256'), json_extract(payload, '$.blob') FROM events
         WHERE ${SENT_TRANSCRIPTS}
         UNION ALL
         SELECT json_extract(payload, '$.digest'), json_extract(payload, '$.digestBlob') FROM events
         WHERE ${SENT_TRANSCRIPTS}
       ) refs
       WHERE EXISTS (SELECT 1 FROM blobs b WHERE b.sha256 = refs.sha256)
         AND locator NOT IN (${DELETED_LOCATORS})
       ORDER BY locator`,
    )
    .all() as Reference[];
}

export function blobFor(store: Store, reference: Reference): QueuedBlob | undefined {
  const row = store.db.query("SELECT bytes FROM blobs WHERE sha256 = ?").get(reference.sha256) as {
    bytes: Uint8Array;
  } | null;

  return row === null ? undefined : { ...reference, bytes: new Uint8Array(row.bytes) };
}

export function staleCutoffs(store: Store, membership: Membership): boolean {
  for (const member of membership.devices.values()) {
    const cutoff = member.revoked?.cutoff;
    if (cutoff === undefined) continue;

    const authored = store.db.query("SELECT 1 FROM events WHERE author = ? LIMIT 1").get(member.id);
    if (authored === null) continue;

    const known = store.db
      .query("SELECT sequence, hash FROM cutoffs WHERE author = ?")
      .get(member.id) as { sequence: number; hash: string } | null;

    if (known?.sequence !== cutoff.sequence || known.hash !== hex(cutoff.hash)) return true;
  }

  return false;
}

export function storedEnvelopes(
  store: Store,
  author: string,
  after: number,
  limit: number,
): AuthoredEvent[] {
  const rows = store.db
    .query(
      `SELECT id, author, sequence, previous, signature, envelope FROM events
       WHERE author = ? AND sequence > ? AND quarantined IS NULL AND envelope IS NOT NULL
       ORDER BY sequence LIMIT ?`,
    )
    .all(author, after, limit) as AuthoredEvent[];

  return rows.map((row) => ({
    ...row,
    signature: new Uint8Array(row.signature),
    envelope: new Uint8Array(row.envelope),
  }));
}

export function storedAuthors(store: Store): string[] {
  const rows = store.db
    .query(
      `SELECT DISTINCT author FROM events
       WHERE author IS NOT NULL AND quarantined IS NULL AND envelope IS NOT NULL ORDER BY author`,
    )
    .all() as { author: string }[];

  return rows.map((row) => row.author);
}

function historyCount(store: Store): number {
  const state = reconciling(store);
  if (state?.heads === undefined) return 0;

  const rows = store.db
    .query(
      `SELECT author, count(*) AS total, sum(sequence <= coalesce(json_extract(?, '$.' || author), 0))
         AS held FROM events
       WHERE author IS NOT NULL AND quarantined IS NULL AND envelope IS NOT NULL GROUP BY author`,
    )
    .all(JSON.stringify(state.heads)) as { total: number; held: number }[];

  return rows.reduce((sum, row) => sum + row.total - row.held, 0);
}

export function quarantinedCount(store: Store, device: string | undefined): number {
  const mark = held(store);
  if (mark === undefined) return 0;

  const through =
    mark.device === device || device === undefined ? Number.MAX_SAFE_INTEGER : mark.through;

  const { outbox } = store.db
    .query(`SELECT count(*) AS outbox FROM events WHERE ${UNSENT} AND seq <= ?`)
    .get(through) as { outbox: number };

  const { revoked } = store.db
    .query("SELECT count(*) AS revoked FROM events WHERE author = ? AND quarantined = 'revoked'")
    .get(mark.device) as { revoked: number };

  return outbox + revoked;
}

export const OPEN_CONFLICTS = `SELECT DISTINCT json_extract(c.payload, '$.path') AS path, c.project, c.plan
  FROM events c
  WHERE c.type = 'copy-conflict' AND c.machine = ? AND c.quarantined IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM revisions r JOIN events e ON e.id = r.event
      WHERE r.path = json_extract(c.payload, '$.path') AND e.seq > c.seq AND ${RECORDED_HERE})
    AND NOT EXISTS (
      SELECT 1 FROM files r JOIN events e ON e.id = r.event
      WHERE r.path = json_extract(c.payload, '$.path') AND e.seq > c.seq AND ${RECORDED_HERE})
    AND NOT EXISTS (
      SELECT 1 FROM landings l
      WHERE l.event = json_extract(c.payload, '$.event') AND l.state = 'landed')`;

export function counts(store: Store): Counts {
  const device = syncMeta(store).device;
  const one = (sql: string, ...params: (string | number)[]) =>
    (store.db.query(sql).get(...params) as { n: number }).n;

  const outbox =
    device === undefined
      ? one(`SELECT count(*) AS n FROM events WHERE ${UNSENT}`)
      : unsealedCount(store, device) +
        one(
          `SELECT count(*) AS n FROM events
           WHERE author = ? AND sequence > ? AND quarantined IS NULL`,
          device,
          syncMeta(store).pushed,
        );

  return {
    queue: outbox + one("SELECT count(*) AS n FROM blob_uploads"),
    quarantined: quarantinedCount(store, device),
    fetching: one("SELECT count(*) AS n FROM blob_fetches"),
    history: historyCount(store),
    conflicts: one(`SELECT count(*) AS n FROM (${OPEN_CONFLICTS})`, store.machine),
    transcripts: {
      pending: one(
        `SELECT count(*) AS n FROM events WHERE type = 'transcript' AND (${UNSENT}
           OR (author = ? AND sequence > ? AND quarantined IS NULL))`,
        device ?? "",
        syncMeta(store).pushed,
      ),
      withheld:
        one("SELECT coalesce(sum(withheld), 0) AS n FROM transcript_cursors") +
        one("SELECT count(*) AS n FROM events WHERE type = 'transcript' AND withheld = 1"),
    },
  };
}

function unsealedCount(store: Store, device: string): number {
  const mark = held(store);
  const through =
    mark === undefined ? 0 : mark.device === device ? Number.MAX_SAFE_INTEGER : mark.through;

  const { n } = store.db
    .query(`SELECT count(*) AS n FROM events WHERE ${UNSENT} AND seq > ?`)
    .get(through) as { n: number };

  return n;
}

function withParent(record: RemoteRecord, copies: ReadonlyMap<string, string>): RemoteRecord {
  const payload = record.payload as Record<string, unknown> | null;
  const parent = typeof payload?.parent === "string" ? copies.get(payload.parent) : undefined;
  return parent === undefined ? record : { ...record, payload: { ...payload, parent } };
}

export async function publishQuarantine(
  root: string,
  local: Store,
  device: string,
): Promise<number> {
  if (held(local) === undefined) return 0;

  return commitEvents(root, (store, touch) => {
    const mark = held(store);
    if (mark === undefined) return 0;

    const count = quarantinedCount(store, device);
    const revoked = store.db
      .query(
        `SELECT ${RECORD_COLUMNS} FROM events
         WHERE author = ? AND quarantined = 'revoked' ORDER BY seq`,
      )
      .all(mark.device) as EventRow[];

    const copies = new Map<string, string>();
    for (const { record: original } of revoked.map(recordOf)) {
      const copy = Bun.randomUUIDv7("hex", original.wall);
      copies.set(original.id, copy);

      const record = withParent(original, copies);
      store.db.run(
        `INSERT INTO events (id, machine, wall, counter, ts, project, plan, type, legacy, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          copy,
          record.machine,
          record.wall,
          record.counter,
          record.ts,
          record.project,
          record.plan,
          record.type,
          record.legacy ? 1 : 0,
          JSON.stringify(record.payload),
        ],
      );

      indexRevision(store, { ...record, id: copy });
      touchViews(touch, { ...record, id: copy });
    }

    for (const [original, copy] of copies)
      store.db.run(
        `UPDATE events SET payload = json_set(payload, '$.parent', ?)
         WHERE author IS NULL AND type = 'revision' AND json_extract(payload, '$.parent') = ?`,
        [copy, original],
      );

    writeMeta(store, "held", undefined);
    return count;
  });
}

export function recordConflict(
  store: Store,
  conflict: {
    project: string;
    plan: string;
    path: string;
    sha256: string;
    event: string;
    local: string;
  },
): void {
  const { project, plan, ...payload } = conflict;
  appendEvent(store, {
    kind: "stored",
    type: "copy-conflict",
    at: Date.now(),
    project,
    plan,
    payload,
  });
}

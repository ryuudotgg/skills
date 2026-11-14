import { CryptoRefusal, ENVELOPE, envelopeEpoch, open, seal } from "skills-core";
import {
  blobFor,
  deletionSent,
  fetchFailed,
  pendingDeletions,
  queuedFetches,
  queuedUploads,
  type Fetch,
  referencedLocators,
  sentBlob,
  tombstones,
  uploaded,
  type QueuedBlob,
} from "../plans/outbox.ts";
import { isDeleted, type Store } from "../plans/store.ts";
import { applyRemoteEvents, type RemoteBlob } from "../plans/sync.ts";
import { missingChunks } from "../sessions/restore.ts";
import { missingDigests } from "../sessions/show.ts";
import { HubRefusal } from "./client.ts";
import { Offline } from "./network.ts";
import {
  BYTES_BATCH,
  bytes,
  base64,
  call,
  chunks,
  graver,
  HAVE,
  listOf,
  pulledOf,
  SAMPLE_BODY,
  Spent,
  verifierFor,
  wide,
  type Pulled,
  type Run,
  type Stuck,
} from "./run.ts";

type Sealable = Pick<QueuedBlob, "locator" | "bytes">;

async function sealBlob(run: Run, blob: Sealable): Promise<Uint8Array> {
  const key = await run.keys.current(run.current.membership.checkpoint.epoch, "blobs");
  return seal(key, blob.bytes, blob.locator);
}

type Holdings = { readonly missing: ReadonlySet<string>; readonly deleted: ReadonlySet<string> };

export async function holdings(run: Run, locators: readonly string[]): Promise<Holdings> {
  const missing = new Set<string>();
  const deleted = new Set<string>();
  for (const slice of chunks(locators, HAVE)) {
    const have = await call(run, "POST", "/v1/blobs/have", { ids: slice });
    for (const id of listOf(have, "missing")) missing.add(String(id));
    for (const id of listOf(have, "deleted")) deleted.add(String(id));
  }

  return { missing, deleted };
}

const SETTLED_BLOB = new Set(["blob-conflict", "blob-deleted"]);

const UPLOAD_BYTES = 64 * 1024 * 1024;

const BLIND_BYTES = 256 * 1024;

export async function putSealed(run: Run, blob: Sealable): Promise<void> {
  const body = { envelope: base64(await sealBlob(run, blob)) };
  await call(run, "PUT", `/v1/blobs/${blob.locator}`, body);
}

async function putOne(run: Run, blob: QueuedBlob): Promise<number> {
  try {
    await putSealed(run, blob);
    return 1;
  } catch (error) {
    if (!(error instanceof HubRefusal)) throw error;
    if (SETTLED_BLOB.has(error.reason)) return 0;
    if (error.reason !== "too-large") throw error;

    run.report.heldBlobs.add(blob.sha256);
    return 0;
  }
}

function wireBytes(blob: QueuedBlob): number {
  return Math.ceil((blob.bytes.length + ENVELOPE.overhead) / 3) * 4 + blob.locator.length + 16;
}

export function mebibytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function tooSlow(stuck: Stuck, bandwidth: number | undefined): Offline {
  const rate = bandwidth === undefined ? "" : ` at ${mebibytes(bandwidth * 1000)}/s`;
  return new Offline(
    `a ${mebibytes(stuck.size)} ${stuck.kind} takes longer to send${rate} than one sync allows, run skills hub sync again from a faster network`,
  );
}

const calibrations = new WeakMap<Run, Promise<void>>();

function calibrate(run: Run): Promise<void> {
  const known = calibrations.get(run);
  if (known !== undefined) return known;

  const started = (async () => {
    const blob = sentBlob(run.deps.store, run.current.device);
    if (blob === undefined) return;

    try {
      const body = { envelope: base64(await sealBlob(run, blob)) };
      await call(run, "PUT", `/v1/blobs/${blob.locator}`, body, true);
    } catch (error) {
      if (!(error instanceof HubRefusal)) throw error;
    }
  })();

  calibrations.set(run, started);
  return started;
}

async function upload(run: Run, blob: QueuedBlob): Promise<void> {
  const { budget, report } = run;
  const bytes = wireBytes(blob);
  const blind = budget.bandwidth === undefined && bytes > BLIND_BYTES;
  if (budget.measured === undefined && (blind || !budget.fits(bytes, 0))) await calibrate(run);

  if (!budget.fits(bytes, 0))
    report.stuck ??= { kind: "blob", id: blob.sha256, size: blob.bytes.length };

  const sent = await putOne(run, blob);
  report.pushedBlobs += sent;
  if (!report.heldBlobs.has(blob.sha256)) uploaded(run.deps.store, [blob.sha256]);
}

function probeOf(blobs: readonly QueuedBlob[]): QueuedBlob | undefined {
  const bySize = [...blobs].sort((a, b) => a.bytes.length - b.bytes.length);
  return bySize.find((blob) => wireBytes(blob) >= SAMPLE_BODY) ?? bySize[0];
}

export async function flushUploads(run: Run): Promise<void> {
  const { store } = run.deps;
  for (;;) {
    const queued = queuedUploads(store, BYTES_BATCH, UPLOAD_BYTES, [...run.report.heldBlobs]);
    if (queued.length === 0) return;

    const { missing } = await holdings(
      run,
      queued.map((blob) => blob.locator),
    );

    const sending = queued.filter((blob) => missing.has(blob.locator));
    uploaded(
      store,
      queued.filter((blob) => !missing.has(blob.locator)).map((blob) => blob.sha256),
    );

    const probe = run.budget.measured === undefined ? probeOf(sending) : undefined;
    if (probe !== undefined) await upload(run, probe);
    await wide(
      sending.filter((blob) => blob !== probe),
      (blob) => upload(run, blob),
    );
  }
}

type Fetched =
  | { readonly kind: "bytes"; readonly plain: Uint8Array }
  | { readonly kind: "deleted"; readonly event: Pulled }
  | { readonly kind: "failed" };

const FAILED: Fetched = { kind: "failed" };
function tombstoneOf(error: HubRefusal): Fetched {
  if (error.reason !== "blob-deleted" || error.status !== 410) return FAILED;

  try {
    return { kind: "deleted", event: pulledOf({ ...(error.detail.event as object), hub_seq: 0 }) };
  } catch {
    return FAILED;
  }
}

export async function fetchOne(run: Run, locator: string): Promise<Fetched> {
  try {
    const body = await call(run, "GET", `/v1/blobs/${locator}`);
    const envelope = bytes(body.envelope);
    const key = run.keys.get(envelopeEpoch(envelope), "blobs");
    if (key === undefined) return FAILED;

    return { kind: "bytes", plain: await open(await key, envelope, locator) };
  } catch (error) {
    if (error instanceof HubRefusal && error.status !== 426) return tombstoneOf(error);
    if (error instanceof CryptoRefusal) return FAILED;
    throw error;
  }
}

type FetchQueue = {
  batch: number;
  next(limit: number): Fetch[];
  queued(fetch: Fetch): boolean;
  failed(digests: readonly string[]): void;
};

const TRANSCRIPT_BATCH = 8;

async function drain(run: Run, queue: FetchQueue): Promise<void> {
  const verifier = verifierFor(run.current, run.keys);
  const failed = new Set<string>();
  for (;;) {
    run.budget.check();

    const batch = queue
      .next(queue.batch + failed.size)
      .filter((fetch) => !failed.has(fetch.sha256));

    if (batch.length === 0) return;

    let interrupted: { error: unknown } | undefined;
    const results = await wide(batch, async (fetch): Promise<Fetched | undefined> => {
      try {
        return await fetchOne(run, fetch.locator);
      } catch (error) {
        interrupted = graver(interrupted, error);
        return undefined;
      }
    });

    const blobs: RemoteBlob[] = [];
    const deletions: Pulled[] = [];
    batch.forEach((fetch, index) => {
      const result = results[index];
      if (result === undefined) return;
      if (result.kind === "bytes")
        blobs.push({ event: fetch.event, sha256: fetch.sha256, bytes: result.plain });
      else if (result.kind === "deleted") deletions.push(result.event);
      else failed.add(fetch.sha256);
    });

    if (deletions.length > 0) {
      const applied = await applyRemoteEvents(run.root, { events: deletions, blobs: [] }, verifier);

      run.report.refused += applied.quarantined.signature + applied.quarantined.malformed;

      for (const [index, fetch] of batch.entries())
        if (results[index]?.kind === "deleted" && queue.queued(fetch)) failed.add(fetch.sha256);
    }

    if (blobs.length > 0) {
      const applied = await applyRemoteEvents(run.root, { events: [], blobs }, verifier);
      run.report.pulledBlobs += applied.blobs;

      const refused = new Set(applied.refused);
      for (const fetch of batch) if (refused.has(fetch.event)) failed.add(fetch.sha256);
    }

    queue.failed(batch.filter((fetch) => failed.has(fetch.sha256)).map((fetch) => fetch.sha256));
    if (interrupted !== undefined) throw interrupted.error;
  }
}

export async function fetchBlobs(run: Run): Promise<void> {
  const { store } = run.deps;
  await drain(run, {
    batch: BYTES_BATCH,
    next: (limit) => queuedFetches(store, limit),
    queued: (fetch) =>
      store.db.query("SELECT 1 FROM blob_fetches WHERE sha256 = ?").get(fetch.sha256) !== null,
    failed: (digests) => fetchFailed(store, digests),
  });
}

function settled(store: Store, fetch: Fetch): boolean {
  const held = store.db.query("SELECT 1 FROM blobs WHERE sha256 = ?").get(fetch.sha256);
  return held !== null || isDeleted(store.db, fetch.locator);
}

function chunkQueue(store: Store, fetches: readonly Fetch[]): FetchQueue {
  let open: Fetch[] = [];
  let cursor = 0;
  return {
    batch: TRANSCRIPT_BATCH,
    next(limit) {
      open = open.filter((fetch) => !settled(store, fetch));

      const wanted = Math.min(limit, TRANSCRIPT_BATCH);
      const fresh = fetches.slice(cursor, cursor + Math.max(0, wanted - open.length));
      cursor += fresh.length;
      open.push(...fresh);
      return open.slice(0, wanted);
    },
    queued: (fetch) => !settled(store, fetch),
    failed(digests) {
      const retired = new Set(digests);
      open = open.filter((fetch) => !retired.has(fetch.sha256));
    },
  };
}

export async function fetchTranscripts(run: Run): Promise<void> {
  const { store } = run.deps;
  try {
    const fetches = [...missingChunks(store, run.root), ...missingDigests(store, run.root)];
    await drain(run, chunkQueue(store, fetches));
  } catch (error) {
    if (!(error instanceof Spent)) throw error;
  }
}

export async function reuploadBlobs(run: Run): Promise<void> {
  const { store } = run.deps;
  for (const group of chunks(referencedLocators(store), HAVE)) {
    const { missing } = await holdings(
      run,
      group.map((reference) => reference.locator),
    );

    let batch: QueuedBlob[] = [];
    let size = 0;
    for (const reference of group.filter((each) => missing.has(each.locator))) {
      const blob = blobFor(store, reference);
      if (blob === undefined) continue;

      batch.push(blob);
      size += blob.bytes.length;
      if (batch.length < BYTES_BATCH && size < UPLOAD_BYTES) continue;

      await wide(batch, (each) => upload(run, each));
      batch = [];
      size = 0;
    }

    await wide(batch, (each) => upload(run, each));
  }
}

export async function restoreTombstones(run: Run): Promise<void> {
  for (const group of chunks(tombstones(run.deps.store), HAVE)) {
    const have = await call(run, "POST", "/v1/blobs/have", {
      ids: group.map((tombstone) => tombstone.locator),
    });

    const deleted = new Set(listOf(have, "deleted").map(String));

    for (const tombstone of group.filter((entry) => !deleted.has(entry.locator)))
      await call(run, "DELETE", `/v1/blobs/${tombstone.locator}`, { event: tombstone.event });
  }
}

export async function sendDeletions(run: Run): Promise<void> {
  const { store } = run.deps;
  const pending = pendingDeletions(store, run.current.device);
  const sent = await wide(pending, async (deletion): Promise<boolean> => {
    try {
      const body = await call(run, "DELETE", `/v1/blobs/${deletion.locator}`, {
        event: deletion.event,
      });

      deletionSent(store, deletion.event);
      return deletion.own && body.event === deletion.event;
    } catch (error) {
      if (error instanceof HubRefusal && error.reason === "tombstone-event") return false;
      throw error;
    }
  });

  run.report.deletedBlobs += sent.filter(Boolean).length;
}

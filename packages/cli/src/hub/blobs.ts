import { CryptoRefusal, envelopeEpoch, open, seal } from "skills-core";
import {
  blobFor,
  fetchFailed,
  queuedFetches,
  queuedUploads,
  referencedLocators,
  tombstones,
  uploaded,
  type QueuedBlob,
} from "../plans/outbox.ts";
import { applyRemoteEvents, type RemoteBlob } from "../plans/sync.ts";
import { HubRefusal } from "./client.ts";
import {
  BYTES_BATCH,
  bytes,
  base64,
  call,
  chunks,
  HAVE,
  listOf,
  pulledOf,
  verifierFor,
  wide,
  type Pulled,
  type Run,
} from "./run.ts";

async function sealBlob(run: Run, blob: QueuedBlob): Promise<Uint8Array> {
  const key = await run.keys.current(run.current.membership.checkpoint.epoch, "blobs");
  return seal(key, blob.bytes, blob.locator);
}

async function missingOf(run: Run, locators: readonly string[]): Promise<Set<string>> {
  const have = await call(run, "POST", "/v1/blobs/have", { ids: locators });
  return new Set(listOf(have, "missing").map(String));
}

const SETTLED_BLOB = new Set(["blob-conflict", "blob-deleted"]);

export async function putEach(run: Run, blobs: readonly QueuedBlob[]): Promise<number> {
  const sent = await wide(blobs, async (blob): Promise<number> => {
    try {
      const body = { envelope: base64(await sealBlob(run, blob)) };
      await call(run, "PUT", `/v1/blobs/${blob.locator}`, body);
      return 1;
    } catch (error) {
      if (error instanceof HubRefusal && SETTLED_BLOB.has(error.reason)) return 0;
      throw error;
    }
  });

  return sent.reduce((sum, one) => sum + one, 0);
}

async function putBlobs(run: Run, blobs: readonly QueuedBlob[]): Promise<number> {
  let created = 0;
  for (const group of chunks(blobs, HAVE)) {
    const missing = await missingOf(
      run,
      group.map((blob) => blob.locator),
    );

    created += await putEach(
      run,
      group.filter((blob) => missing.has(blob.locator)),
    );
  }

  return created;
}

export async function flushUploads(run: Run): Promise<void> {
  for (;;) {
    const queued = queuedUploads(run.deps.store, BYTES_BATCH);
    if (queued.length === 0) return;

    run.report.pushedBlobs += await putBlobs(run, queued);
    uploaded(
      run.deps.store,
      queued.map((blob) => blob.sha256),
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

async function fetchOne(run: Run, locator: string): Promise<Fetched> {
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

export async function fetchBlobs(run: Run): Promise<void> {
  const verifier = verifierFor(run.current, run.keys);
  const failed = new Set<string>();
  for (;;) {
    run.budget.check();

    const queue = queuedFetches(run.deps.store, BYTES_BATCH + failed.size).filter(
      (fetch) => !failed.has(fetch.sha256),
    );

    if (queue.length === 0) return;

    const results = await wide(queue, (fetch) => fetchOne(run, fetch.locator));
    const blobs: RemoteBlob[] = [];
    const deletions: Pulled[] = [];
    queue.forEach((fetch, index) => {
      const result = results[index] ?? FAILED;
      if (result.kind === "bytes")
        blobs.push({ event: fetch.event, sha256: fetch.sha256, bytes: result.plain });
      else if (result.kind === "deleted") deletions.push(result.event);
      else failed.add(fetch.sha256);
    });

    if (deletions.length > 0) {
      const applied = await applyRemoteEvents(run.root, { events: deletions, blobs: [] }, verifier);

      run.report.refused += applied.quarantined.signature + applied.quarantined.malformed;
      const left = new Set(
        queuedFetches(run.deps.store, Number.MAX_SAFE_INTEGER).map((f) => f.sha256),
      );

      for (const [index, fetch] of queue.entries())
        if (results[index]?.kind === "deleted" && left.has(fetch.sha256)) failed.add(fetch.sha256);
    }

    if (blobs.length > 0) {
      const applied = await applyRemoteEvents(run.root, { events: [], blobs }, verifier);
      run.report.pulledBlobs += applied.blobs;

      const refused = new Set(applied.refused);
      for (const fetch of queue) if (refused.has(fetch.event)) failed.add(fetch.sha256);
    }

    fetchFailed(
      run.deps.store,
      queue.filter((fetch) => failed.has(fetch.sha256)).map((fetch) => fetch.sha256),
    );
  }
}

export async function reuploadBlobs(run: Run): Promise<void> {
  const { store } = run.deps;
  for (const group of chunks(referencedLocators(store), HAVE)) {
    const missing = await missingOf(
      run,
      group.map((reference) => reference.locator),
    );

    const absent = group.filter((reference) => missing.has(reference.locator));
    for (const batch of chunks(absent, BYTES_BATCH)) {
      const blobs = batch.flatMap((reference) => blobFor(store, reference) ?? []);
      run.report.pushedBlobs += await putEach(run, blobs);
    }
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

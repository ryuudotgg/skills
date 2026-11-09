import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CryptoRefusal,
  envelopeEpoch,
  fromHex,
  hex,
  open,
  seal,
  signEvent,
  subkey,
  verifyEvent,
  type AuthoredEvent as CoreEvent,
  type EpochKey,
  type Id,
  type Subkey,
} from "skills-core";
import { tryLock } from "../lock.ts";
import { openPlansStore, recordWorkingCopies } from "../plans/commit.ts";
import { plansDir } from "../plans/index-tsv.ts";
import { landWorkingCopies, type Conflicted, type Landed } from "../plans/landing.ts";
import {
  acknowledge,
  blobFor,
  counts,
  fetchFailed,
  finishSync,
  held,
  hold,
  lastSync,
  previousOf,
  publishQuarantine,
  quarantinedCount,
  queuedFetches,
  queuedUploads,
  reconciledAt,
  reconciling,
  referencedLocators,
  release,
  setReconciling,
  setReconcilingIn,
  staleCutoffs,
  stop,
  storedAuthors,
  storedEnvelopes,
  stopped,
  storeSealed,
  tailOf,
  unacknowledged,
  unsealed,
  unsealAfter,
  uploaded,
  type QueuedBlob,
  type Sealed,
  type Tail,
} from "../plans/outbox.ts";
import { CTX_FILE, openStore, PLAN_FILE, write, type Store } from "../plans/store.ts";
import {
  applyRemoteEvents,
  setSyncMeta,
  syncMeta,
  type AuthoredEvent,
  type RemoteBlob,
  type RemoteRecord,
  type Verifier,
} from "../plans/sync.ts";
import { connect, HubRefusal, hubSetting, networkOf, Offline } from "./client.ts";
import {
  EnrollRefusal,
  announce,
  enrolled,
  labelOf,
  sentence,
  settle,
  type Deps,
  type Enrolled,
} from "./enroll.ts";
import { keyStore } from "./keys.ts";
import { ForkDetected, readLocal, readPending, verifiedLocal } from "./vault.ts";

export const SHORT_BUDGET = 2_000;

export const LONG_BUDGET = 30_000;

const BATCH = 500;

const HAVE = 1_000;

const WIDE = 8;

export type SyncOptions = {
  readonly budget: number;
  readonly publishQuarantine: boolean;
  readonly confirm?: (waiting: number) => Promise<boolean>;
  readonly quiet: boolean;
};

export type SyncReport = {
  pushedEvents: number;
  pushedBlobs: number;
  pulledEvents: number;
  pulledBlobs: number;
  landed: Landed[];
  conflicts: Conflicted[];
  reconciled: boolean;
  refused: number;
};

class Budget {
  readonly deadline: number;

  constructor(ms: number) {
    this.deadline = Date.now() + ms;
  }

  check(): void {
    if (Date.now() > this.deadline)
      throw new Offline("the sync ran out of its time budget, run it again to continue");
  }
}

export function stopMessage(label: string): string {
  return `the hub holds other events under this device's sequence numbers, so this store was restored or copied from another machine: revoke device ${label} from another machine, then run skills hub join here`;
}

const FORGOTTEN =
  "the hub does not know this device, so it was restored from a backup older than this enrollment: run skills hub sync on a machine enrolled before that backup, which repairs the hub's chain, then sync here again";

const REVOKED =
  "the hub refuses this device as revoked, enroll this machine again with an invite from another machine";

function rootOf(store: Store): string {
  return dirname(store.db.filename);
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function bytes(value: unknown): Uint8Array {
  if (typeof value !== "string") throw new Offline("the hub sent bytes that are not base64");
  return new Uint8Array(Buffer.from(value, "base64"));
}

function wire(event: AuthoredEvent) {
  return {
    id: event.id,
    author: event.author,
    sequence: event.sequence,
    previous: event.previous,
    envelope: base64(event.envelope),
    signature: base64(event.signature),
  };
}

type Pulled = AuthoredEvent & { hub_seq: number };

function pulledOf(value: unknown): Pulled {
  const raw = (value ?? {}) as Record<string, unknown>;
  const { id, author, sequence, previous, hub_seq: seq } = raw;
  if (
    typeof id !== "string" ||
    typeof author !== "string" ||
    typeof sequence !== "number" ||
    typeof previous !== "string" ||
    typeof seq !== "number"
  )
    throw new Offline("the hub sent an event that does not parse");

  return {
    id,
    author,
    sequence,
    previous,
    envelope: bytes(raw.envelope),
    signature: bytes(raw.signature),
    hub_seq: seq,
  };
}

function listOf(body: Record<string, unknown>, key: string): unknown[] {
  const value = body[key];
  if (!Array.isArray(value)) throw new Offline(`the hub sent no ${key} list`);
  return value;
}

async function wide<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });

  let next = 0;
  async function lane(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T);
    }
  }

  await Promise.all(Array.from({ length: Math.min(WIDE, items.length) }, lane));
  return results;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );
}

class Keys {
  readonly #cache = new Map<string, Promise<Subkey<"events" | "blobs">>>();
  readonly #keys: ReadonlyMap<number, EpochKey>;

  constructor(keys: ReadonlyMap<number, EpochKey>) {
    this.#keys = keys;
  }

  get(epoch: number, purpose: "events" | "blobs"): Promise<Subkey<"events" | "blobs">> | undefined {
    const key = this.#keys.get(epoch);
    if (key === undefined) return undefined;

    const name = `${purpose}/${epoch}`;
    const known = this.#cache.get(name);
    if (known !== undefined) return known;

    const derived = subkey(key, purpose);
    this.#cache.set(name, derived);
    return derived;
  }

  current(epoch: number, purpose: "events" | "blobs"): Promise<Subkey<"events" | "blobs">> {
    const found = this.get(epoch, purpose);
    if (found === undefined)
      throw new EnrollRefusal("this device holds no key for the current epoch");

    return found;
  }
}

function coreEvent(event: AuthoredEvent): CoreEvent {
  return {
    id: event.id,
    author: event.author as Id,
    sequence: event.sequence,
    previous: fromHex(event.previous),
    envelope: new Uint8Array(event.envelope),
    signature: new Uint8Array(event.signature),
  };
}

export function verifierFor(current: Enrolled, keys: Keys): Verifier {
  const { membership } = current;
  return {
    async open(event) {
      let core: CoreEvent;
      try {
        core = coreEvent(event);
        const tail =
          core.sequence === 1 ? undefined : { sequence: core.sequence - 1, hash: core.previous };

        await verifyEvent(membership, core, tail);
      } catch (error) {
        if (!(error instanceof CryptoRefusal) || error.reason !== "event-cutoff") return undefined;
      }

      try {
        const key = keys.get(envelopeEpoch(event.envelope), "events");
        if (key === undefined) return undefined;

        const plain = await open(await key, event.envelope, event.id);
        return JSON.parse(new TextDecoder().decode(plain)) as RemoteRecord;
      } catch {
        return undefined;
      }
    },
    cutoff(author) {
      const revoked = membership.devices.get(author as Id)?.revoked;
      return revoked && { sequence: revoked.cutoff.sequence, hash: hex(revoked.cutoff.hash) };
    },
  };
}

type Run = {
  readonly deps: Deps;
  readonly root: string;
  readonly budget: Budget;
  keys: Keys;
  current: Enrolled;
  readonly report: SyncReport;
};

async function call(
  run: Run,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  run.budget.check();
  return run.current.client.call(method, path, body, run.current.signer);
}

async function sealBatch(run: Run): Promise<number> {
  const { store } = run.deps;
  const { device } = run.current;
  const batch = unsealed(store, device, BATCH);
  if (batch.length === 0) return 0;

  const key = await run.keys.current(run.current.membership.checkpoint.epoch, "events");
  const author = { id: device, keys: run.current.keys.sign };

  let tail: Tail | undefined = tailOf(store, device);
  const sealed: Sealed[] = [];
  for (const { seq, record } of batch) {
    const envelope = await seal(key, new TextEncoder().encode(JSON.stringify(record)), record.id);
    const previous = tail && { sequence: tail.sequence, hash: fromHex(tail.hash) };
    const signed = await signEvent(author, record.id, envelope, previous);

    sealed.push({
      seq,
      id: record.id,
      author: device,
      sequence: signed.event.sequence,
      previous: previousOf(tail),
      signature: signed.event.signature,
      envelope: signed.event.envelope,
    });

    tail = { sequence: signed.tail.sequence, hash: hex(signed.tail.hash) };
  }

  storeSealed(store, sealed);
  return sealed.length;
}

async function sealBlob(run: Run, blob: QueuedBlob): Promise<Uint8Array> {
  const key = await run.keys.current(run.current.membership.checkpoint.epoch, "blobs");
  return seal(key, blob.bytes, blob.locator);
}

async function missingOf(run: Run, locators: readonly string[]): Promise<Set<string>> {
  const have = await call(run, "POST", "/v1/blobs/have", { ids: locators });
  return new Set(listOf(have, "missing").map(String));
}

async function putEach(run: Run, blobs: readonly QueuedBlob[]): Promise<number> {
  const sent = await wide(blobs, async (blob): Promise<number> => {
    try {
      const body = { envelope: base64(await sealBlob(run, blob)) };
      await call(run, "PUT", `/v1/blobs/${blob.locator}`, body);
      return 1;
    } catch (error) {
      if (error instanceof HubRefusal && error.reason === "blob-conflict") return 0;
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

async function flushUploads(run: Run): Promise<void> {
  for (;;) {
    const queued = queuedUploads(run.deps.store, HAVE);
    if (queued.length === 0) return;

    run.report.pushedBlobs += await putBlobs(run, queued);
    uploaded(
      run.deps.store,
      queued.map((blob) => blob.sha256),
    );
  }
}

const CLONED = new Set(["sequence-taken", "event-conflict"]);
async function submit(run: Run, history: boolean, batch: readonly AuthoredEvent[]): Promise<void> {
  const path = history ? "/v1/events?history=1" : "/v1/events";
  try {
    await call(run, "POST", path, { events: batch.map(wire) });
  } catch (error) {
    if (!(error instanceof HubRefusal) || !CLONED.has(error.reason)) throw error;

    const { device, membership, epochKeys } = run.current;
    stop(run.deps.store, { device, reason: error.reason });
    throw new EnrollRefusal(stopMessage(await labelOf(membership, epochKeys, device)));
  }
}

async function pushBatch(run: Run): Promise<boolean> {
  const { store } = run.deps;
  const batch = unacknowledged(store, run.current.device, BATCH);
  if (batch.length === 0) return false;

  try {
    await submit(run, false, batch);
  } catch (error) {
    if (!(error instanceof HubRefusal) || error.reason !== "epoch-below-current") throw error;

    const answer = await call(run, "POST", "/v1/events?history=1", { events: [] });
    const heads = (answer.authors ?? {}) as Record<string, number>;
    unsealAfter(store, run.current.device, heads[run.current.device] ?? 0);

    const epoch = run.current.membership.checkpoint.epoch;
    run.current = await enrolled(run.deps, run.current.client.url, true, run.current.client);
    run.keys = new Keys(run.current.epochKeys);

    if (run.current.membership.checkpoint.epoch <= epoch)
      throw new Offline("the hub refused this device's epoch, run skills hub sync again");

    return true;
  }

  acknowledge(store, batch.at(-1)?.sequence ?? 0);
  run.report.pushedEvents += batch.length;
  return true;
}

async function pushOutbox(run: Run): Promise<void> {
  for (;;) {
    run.budget.check();

    const sealed = unacknowledged(run.deps.store, run.current.device, 1).length > 0;
    if (!sealed && (await sealBatch(run)) === 0) break;

    await flushUploads(run);
    await pushBatch(run);
  }

  await flushUploads(run);

  if (stopped(run.deps.store)?.device === run.current.device) stop(run.deps.store, undefined);
}

async function pullPage(run: Run, verifier: Verifier): Promise<boolean> {
  const { pulled } = syncMeta(run.deps.store);
  const body = await call(run, "GET", `/v1/events?after=${pulled}&limit=${BATCH}`);
  const events = listOf(body, "events").map(pulledOf);
  const last = events.at(-1);
  if (last === undefined) return false;

  const applied = await applyRemoteEvents(
    run.root,
    { events, blobs: [], meta: { pulled: last.hub_seq, pulledId: last.id } },
    verifier,
  );

  run.report.pulledEvents += applied.applied;
  run.report.refused += applied.quarantined.signature + applied.quarantined.malformed;
  return typeof body.head === "number" && last.hub_seq < body.head;
}

async function refoldCutoffs(run: Run): Promise<void> {
  if (!staleCutoffs(run.deps.store, run.current.membership)) return;
  const verifier = verifierFor(run.current, run.keys);
  await applyRemoteEvents(run.root, { events: [], blobs: [] }, verifier);
}

async function pullEvents(run: Run): Promise<void> {
  const verifier = verifierFor(run.current, run.keys);
  while (await pullPage(run, verifier)) run.budget.check();
  await refoldCutoffs(run);
}

async function fetchOne(run: Run, locator: string): Promise<Uint8Array | undefined> {
  try {
    const body = await call(run, "GET", `/v1/blobs/${locator}`);
    const envelope = bytes(body.envelope);
    const key = run.keys.get(envelopeEpoch(envelope), "blobs");
    if (key === undefined) return undefined;

    return await open(await key, envelope, locator);
  } catch (error) {
    if (error instanceof HubRefusal && error.status !== 426) return undefined;
    if (error instanceof CryptoRefusal) return undefined;
    throw error;
  }
}

async function fetchBlobs(run: Run): Promise<void> {
  const verifier = verifierFor(run.current, run.keys);
  const failed = new Set<string>();
  for (;;) {
    run.budget.check();

    const queue = queuedFetches(run.deps.store, BATCH + failed.size).filter(
      (fetch) => !failed.has(fetch.sha256),
    );

    if (queue.length === 0) return;

    const results = await wide(queue, (fetch) => fetchOne(run, fetch.locator));
    const blobs: RemoteBlob[] = [];
    queue.forEach((fetch, index) => {
      const plain = results[index];
      if (plain === undefined) failed.add(fetch.sha256);
      else blobs.push({ event: fetch.event, bytes: plain });
    });

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

async function diverged(run: Run): Promise<boolean> {
  const { store } = run.deps;
  if (reconciling(store) !== undefined) return true;

  const meta = syncMeta(store);
  if (meta.incarnation !== undefined && meta.incarnation !== run.current.client.incarnation)
    return true;

  if (meta.pulled === 0) return false;

  const body = await call(run, "GET", `/v1/events?after=${meta.pulled - 1}&limit=1`);
  const [first] = listOf(body, "events").map(pulledOf);
  return first === undefined || first.hub_seq !== meta.pulled || first.id !== meta.pulledId;
}

async function pushHistory(run: Run): Promise<void> {
  const { store } = run.deps;
  const answer = await call(run, "POST", "/v1/events?history=1", { events: [] });
  const heads = { ...((answer.authors ?? {}) as Record<string, number>) };
  setReconciling(store, { incarnation: run.current.client.incarnation, heads });

  for (const author of storedAuthors(store))
    for (;;) {
      const batch = storedEnvelopes(store, author, heads[author] ?? 0, BATCH);
      const last = batch.at(-1);
      if (last === undefined) break;

      await submit(run, true, batch);
      heads[author] = last.sequence;
      run.report.pushedEvents += batch.length;
      setReconciling(store, { incarnation: run.current.client.incarnation, heads });

      const { pushed } = syncMeta(store);
      if (author === run.current.device && last.sequence > pushed)
        acknowledge(store, last.sequence);
    }
}

async function reuploadBlobs(run: Run): Promise<void> {
  const { store } = run.deps;
  for (const group of chunks(referencedLocators(store), HAVE)) {
    const missing = await missingOf(
      run,
      group.map((reference) => reference.locator),
    );

    const blobs = group
      .filter((reference) => missing.has(reference.locator))
      .flatMap((reference) => blobFor(store, reference) ?? []);

    run.report.pushedBlobs += await putEach(run, blobs);
  }
}

async function reconcile(run: Run): Promise<void> {
  const { store } = run.deps;
  const incarnation = run.current.client.incarnation;
  const state = reconciling(store);
  run.report.reconciled = true;
  if (state?.phase === "pull" && state.incarnation === incarnation) return;

  setReconciling(store, { incarnation });
  await refoldCutoffs(run);
  await pushHistory(run);
  await reuploadBlobs(run);

  write(store, () => {
    setSyncMeta(store, { pulled: 0, incarnation });
    setReconcilingIn(store, { incarnation, phase: "pull" });
  });
}

function projectsOf(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .filter((name) => existsSync(join(root, name, "index.tsv")));
  } catch {
    return [];
  }
}

function copiesIn(root: string): string[] {
  const names = (dir: string) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };

  return projectsOf(root).flatMap((project) => [
    ...names(join(root, project))
      .filter((name) => PLAN_FILE.test(name) || CTX_FILE.test(name))
      .map((name) => join(root, project, name)),
    ...names(join(root, project, "done"))
      .filter((name) => PLAN_FILE.test(name))
      .map((name) => join(root, project, "done", name)),
  ]);
}

async function start(deps: Deps, url: string, options: SyncOptions): Promise<Run> {
  const budget = new Budget(options.budget);
  const { store } = deps;
  const device = syncMeta(store).device;

  let current: Enrolled;
  try {
    current = await enrolled(deps, url, true, undefined, budget.deadline);
  } catch (error) {
    const revoked =
      (error instanceof HubRefusal && error.reason === "device-revoked") ||
      (error instanceof EnrollRefusal && error.message === "device revoked");

    if (revoked && device !== undefined) {
      hold(store, device);
      throw new EnrollRefusal(REVOKED);
    }

    if (error instanceof HubRefusal && error.reason === "device-unknown")
      throw new EnrollRefusal(FORGOTTEN);

    throw error;
  }

  if (held(store)?.device === current.device) release(store);

  return {
    deps,
    root: rootOf(store),
    budget,
    keys: new Keys(current.epochKeys),
    current,
    report: {
      pushedEvents: 0,
      pushedBlobs: 0,
      pulledEvents: 0,
      pulledBlobs: 0,
      landed: [],
      conflicts: [],
      reconciled: false,
      refused: 0,
    },
  };
}

async function publishHeld(run: Run, options: SyncOptions): Promise<void> {
  const { store } = run.deps;
  const mark = held(store);
  if (mark === undefined || mark.device === run.current.device || options.quiet) return;

  const waiting = quarantinedCount(store, run.current.device);
  const yes =
    waiting > 0 && (options.publishQuarantine || (await options.confirm?.(waiting)) === true);

  if (!yes) {
    if (waiting > 0)
      run.deps.out(
        `quarantined ${waiting} events wait, run skills hub sync --publish-quarantine to publish them`,
      );

    return;
  }

  const published = await publishQuarantine(run.root, store, run.current.device);
  run.deps.out(`published ${published} quarantined events`);
}

export async function syncOnce(deps: Deps, url: string, options: SyncOptions): Promise<SyncReport> {
  const halted = stopped(deps.store);
  const device = syncMeta(deps.store).device;
  if (options.quiet && halted !== undefined && halted.device === device) return emptyReport();
  if (!options.quiet) await recordWorkingCopies(rootOf(deps.store), copiesIn(rootOf(deps.store)));

  const run = await start(deps, url, options);
  if (await diverged(run)) await reconcile(run);
  else if (syncMeta(deps.store).incarnation === undefined)
    write(deps.store, () =>
      setSyncMeta(deps.store, { incarnation: run.current.client.incarnation }),
    );

  run.current = await settle(deps, run.current);
  await pushOutbox(run);
  await pullEvents(run);
  await fetchBlobs(run);

  const landings = landWorkingCopies(deps.store, run.root);
  run.report.landed = landings.landed;
  run.report.conflicts = landings.conflicts;

  await publishHeld(run, options);
  await pushOutbox(run);

  const at = new Date().toISOString();
  finishSync(deps.store, at, run.report.reconciled);

  return run.report;
}

function emptyReport(): SyncReport {
  return {
    pushedEvents: 0,
    pushedBlobs: 0,
    pulledEvents: 0,
    pulledBlobs: 0,
    landed: [],
    conflicts: [],
    reconciled: false,
    refused: 0,
  };
}

export function summary(report: SyncReport): string {
  return `pushed ${report.pushedEvents} events, ${report.pushedBlobs} blobs, pulled ${report.pulledEvents} events, ${report.pulledBlobs} blobs, conflicts ${report.conflicts.length}`;
}

export async function syncVerb(deps: Deps, url: string, options: SyncOptions): Promise<void> {
  const report = await syncOnce(deps, url, options);
  const membership = (await verifiedLocal(readLocal(deps.store))) ?? undefined;
  const view = membership && (await announce(deps, membership));
  for (const landed of report.landed.filter((entry) => entry.replaced)) {
    const label =
      landed.author === null || view === undefined
        ? "this machine"
        : await labelOf(view.membership, view.keys, landed.author as Id);

    deps.out(`landed ${landed.path} from ${label}`);
  }

  for (const conflict of report.conflicts)
    deps.out(
      `conflict ${conflict.path}, run skills plans show --conflict ${conflict.project} ${conflict.plan}`,
    );

  if (report.refused > 0) deps.out(`refused ${report.refused} events that do not verify`);

  deps.out(summary(report));
  if (report.reconciled) deps.out("reconciled");
}

export async function reseed(deps: Deps, url: string): Promise<void> {
  const run = await start(deps, url, {
    budget: LONG_BUDGET,
    publishQuarantine: false,
    quiet: true,
  });

  await reconcile(run);
  finishSync(deps.store, new Date().toISOString(), true);
  deps.out(`reseeded, ${run.report.pushedEvents} events, ${run.report.pushedBlobs} blobs`);
}

export async function pullToHead(deps: Deps, url: string): Promise<void> {
  const run = await start(deps, url, {
    budget: LONG_BUDGET,
    publishQuarantine: false,
    quiet: true,
  });

  await pullEvents(run);
}

export async function statusVerb(
  deps: Deps,
  url: string | undefined,
  network: string,
): Promise<number> {
  if (url === undefined) {
    deps.out("no hub configured");
    return 1;
  }

  const { store } = deps;
  if (readLocal(store).checkpoint === undefined) {
    const pending = readPending(store);
    deps.out(`hub ${url} (${network})`);
    deps.out(pending === undefined ? "not enrolled" : `joining as device ${pending.device}`);
    return 0;
  }

  let incarnation = "-";
  let problem: string | undefined;
  try {
    const current = await enrolled(deps, url, false, undefined, Date.now() + SHORT_BUDGET);
    incarnation = current.client.incarnation;
  } catch (error) {
    const said = sentence(error);
    if (said === undefined) throw error;

    const revoked = error instanceof HubRefusal && error.reason === "device-revoked";
    problem = error instanceof ForkDetected ? said : revoked ? REVOKED : `offline: ${said}`;
  }

  const local = readLocal(store);
  const membership = await verifiedLocal(local);
  if (membership === undefined || local.device === undefined)
    throw new EnrollRefusal("this store is not enrolled, run skills hub init, join or recover");

  const view = await announce(deps, membership);
  const { checkpoint } = membership;
  const enrolledCount =
    [...membership.devices.values()].filter((member) => member.revoked === undefined).length + 1;

  const tally = counts(store);
  const reconciled = reconciledAt(store);
  const lines = [
    `hub ${url} (${network})`,
    `device ${await labelOf(membership, view.keys, local.device)} ${local.device}`,
    `devices ${enrolledCount}`,
    `epoch ${checkpoint.epoch}`,
    `chain ${checkpoint.length} ${checkpoint.length === 1 ? "entry" : "entries"}`,
    `head ${hex(checkpoint.head)}`,
    `incarnation ${incarnation}`,
    `queue ${tally.queue}`,
    `quarantined ${tally.quarantined}`,
    `fetching ${tally.fetching}`,
    `history ${tally.history}`,
    `conflicts ${tally.conflicts}`,
    `last sync ${lastSync(store) ?? "never"}`,
    ...(reconciled === undefined ? [] : [`reconciled ${reconciled}`]),
    ...(problem === undefined ? [] : [problem]),
  ];

  for (const line of lines) deps.out(line);
  return 0;
}

export function hubDeps(store: Store, env: NodeJS.ProcessEnv, out: (line: string) => void): Deps {
  return {
    store,
    keys: keyStore(env),
    connect: (url, deadline) => connect(url, networkOf(env), fetch, undefined, deadline),
    now: Date.now,
    sleep: (ms) => Bun.sleep(ms),
    out,
  };
}

export async function shortSync(env: NodeJS.ProcessEnv): Promise<void> {
  const url = hubSetting(env, "HUB_URL");
  const root = plansDir(env);
  if (url === undefined || !existsSync(join(root, "plans.db"))) return;

  try {
    await tryLock(join(root, "hub.lock"), async () => {
      const store = openStore(join(root, "plans.db"), { busyMs: SHORT_BUDGET / 4 });
      try {
        if (readLocal(store).checkpoint === undefined) return;
        const deps = { ...hubDeps(store, env, () => {}), quiet: true };
        await syncOnce(deps, url, { budget: SHORT_BUDGET, publishQuarantine: false, quiet: true });
      } finally {
        store.db.close();
      }
    });
  } catch {}
}

export async function shortSyncWithin(
  env: NodeJS.ProcessEnv,
  ms = SHORT_BUDGET + 1_000,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });

  const finished = await Promise.race([shortSync(env).then(() => true), expired]);
  clearTimeout(timer);
  return finished;
}

export async function unseenLines(env: NodeJS.ProcessEnv): Promise<string[]> {
  const root = plansDir(env);
  if (hubSetting(env, "HUB_URL") === undefined || !existsSync(join(root, "plans.db"))) return [];

  const lines: string[] = [];
  const store = await openPlansStore(root);
  try {
    const membership = await verifiedLocal(readLocal(store));
    if (membership !== undefined)
      await announce(
        hubDeps(store, env, (line) => lines.push(line)),
        membership,
      );
  } catch {
    return lines;
  } finally {
    store.db.close();
  }

  return lines;
}

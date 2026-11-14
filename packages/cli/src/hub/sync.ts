import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  envelopeEpoch,
  fromHex,
  hex,
  MAX_FILE_SIZE,
  seal,
  signEvent,
  TRANSCRIPT_EVENT,
  type Id,
  type TranscriptRecord,
} from "skills-core";
import { tryLock } from "../lock.ts";
import { MISSING, type Tailnet } from "./tailscale.ts";
import { Refusal } from "../plans/import.ts";
import { chunkTranscripts, forgetDigests, uncutBytes } from "../sessions/chunks.ts";
import { authorDeletions, GATED_TYPES, pushGate } from "../sessions/gate.ts";
import { scanSessions } from "../sessions/scan.ts";
import { hostDirs } from "../sessions/transcripts.ts";
import { openPlansStore, recordWorkingCopies } from "../plans/commit.ts";
import { landFiles, projectsOf, walkFiles } from "../plans/files.ts";
import { plansDir } from "../plans/index-tsv.ts";
import { landWorkingCopies } from "../plans/landing.ts";
import {
  acknowledge,
  backlog,
  counts,
  dropUnsentUploads,
  malformedFileEvents,
  markRecheckedFiles,
  recheckedFiles,
  finishSync,
  held,
  hold,
  lastSync,
  previousOf,
  publishQuarantine,
  quarantinedCount,
  reconciledAt,
  reconciling,
  release,
  sealedRecords,
  setReconciling,
  setReconcilingIn,
  setStuckItem,
  forgetPace,
  savePace,
  staleCutoffs,
  stop,
  storedAuthors,
  storedEnvelopes,
  stopped,
  storeSealed,
  stuckItem,
  tailOf,
  unacknowledged,
  unsealed,
  unsealAfter,
  savedPace,
  withhold,
  type Sealed,
  type Tail,
} from "../plans/outbox.ts";
import { CTX_FILE, isCopyKey, openStore, PLAN_FILE, write, type Store } from "../plans/store.ts";
import {
  applyRemoteEvents,
  setSyncMeta,
  syncMeta,
  type AuthoredEvent,
  type Verifier,
} from "../plans/sync.ts";
import { connect, HubRefusal, type Fetch } from "./client.ts";
import { hubSetting, networkOf, Offline } from "./network.ts";
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
import { hubLeases, leaserOf, syncLeases } from "./leases.ts";
import { ForkDetected, readLocal, readPending, verifiedLocal } from "./vault.ts";
import {
  fetchBlobs,
  fetchTranscripts,
  flushUploads,
  mebibytes,
  tooSlow,
  restoreTombstones,
  reuploadBlobs,
  sendDeletions,
} from "./blobs.ts";
import {
  base64,
  BATCH,
  Budget,
  call,
  Keys,
  listOf,
  GRACE,
  pulledOf,
  Spent,
  verifierFor,
  type Run,
  type SyncReport,
} from "./run.ts";

export type { SyncReport } from "./run.ts";

export const SHORT_BUDGET = 2_000;

export const LONG_BUDGET = 30_000;

const QUIET_WALK_BYTES = 8 * 1024 * 1024;

const CHUNK_BYTES = 64 * 1024 * 1024;

export const PARTIAL = 75;

export type SyncOptions = {
  readonly env?: NodeJS.ProcessEnv;
  readonly budget: number;
  readonly chunkBytes?: number;
  readonly publishQuarantine: boolean;
  readonly confirm?: (waiting: number) => Promise<boolean>;
  readonly quiet: boolean;
};

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

function gatedBatch(run: Run): ReturnType<typeof unsealed> {
  const { store } = run.deps;
  const gate = pushGate(store, run.root);

  for (;;) {
    const batch = unsealed(store, run.current.device, BATCH);
    const blocked = batch.filter(({ record }) => !gate.passes(record));
    if (blocked.length === 0)
      return batch.map((each) => ({ ...each, record: gate.outgoing(each.record) }));

    const transcripts = blocked.flatMap(({ record }) =>
      record.type === TRANSCRIPT_EVENT ? [record.payload as TranscriptRecord] : [],
    );

    write(store, () => {
      withhold(
        store,
        blocked.map((each) => each.seq),
      );

      forgetDigests(store, transcripts);
    });
  }
}

async function regate(run: Run): Promise<void> {
  const { store } = run.deps;
  const { device } = run.current;
  const gate = pushGate(store, run.root);
  const failing = sealedRecords(store, device, GATED_TYPES).filter(
    (record) => !gate.passes(record),
  );

  if (failing.length === 0) return;

  const answer = await call(run, "POST", "/v1/events?history=1", { events: [] });
  const head = ((answer.authors ?? {}) as Record<string, number>)[device] ?? 0;
  const { pushed } = syncMeta(store);
  if (head > pushed) acknowledge(store, head);

  const cut = Math.max(head, pushed);
  const unsent = failing.filter((record) => record.sequence > cut);
  if (unsent.length === 0) return;

  const retired = unsent.flatMap((record) =>
    record.type === TRANSCRIPT_EVENT
      ? [{ project: record.project, payload: JSON.stringify(record.payload) }]
      : [],
  );

  write(store, () => {
    unsealAfter(store, device, cut);
    dropUnsentUploads(store);
    authorDeletions(store, run.root, retired);
  });
}

async function sealBatch(run: Run): Promise<number> {
  const { store } = run.deps;
  const { device } = run.current;
  const batch = gatedBatch(run);
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

function eventBytes(batch: readonly AuthoredEvent[]): number {
  return JSON.stringify({ events: batch.map(wire) }).length;
}

const BLIND_BYTES = 256 * 1024;

const BLIND_MS = 4_000;

function fitting<T extends AuthoredEvent>(run: Run, events: readonly T[]): T[] {
  const { budget } = run;
  const admits = (bytes: number) =>
    budget.bandwidth === undefined
      ? bytes <= BLIND_BYTES && Date.now() + BLIND_MS <= budget.deadline
      : budget.fits(bytes);

  let batch = [...events];
  while (batch.length > 1 && !admits(eventBytes(batch)))
    batch = batch.slice(0, Math.ceil(batch.length / 2));

  const [only] = batch;
  const size = eventBytes(batch);
  if (batch.length === 1 && only !== undefined && !run.budget.fits(size, 0))
    run.report.stuck ??= { kind: "event", id: only.id, size };

  return batch;
}

async function pushBatch(run: Run): Promise<boolean> {
  const { store } = run.deps;
  const queued = unacknowledged(store, run.current.device, BATCH);
  if (queued.length === 0) return false;

  const batch = fitting(run, queued);
  try {
    await submit(run, false, batch);
  } catch (error) {
    if (!(error instanceof HubRefusal) || error.reason !== "epoch-below-current") throw error;

    const answer = await call(run, "POST", "/v1/events?history=1", { events: [] });
    const heads = (answer.authors ?? {}) as Record<string, number>;
    unsealAfter(store, run.current.device, heads[run.current.device] ?? 0);

    const [first] = batch;
    const sealedUnder = first === undefined ? 0 : envelopeEpoch(first.envelope);
    run.current = await enrolled(run.deps, run.current.client.url, true, run.current.client);
    run.keys = new Keys(run.current.epochKeys);

    if (run.current.membership.checkpoint.epoch <= sealedUnder)
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
    await refoldCutoffs(run);
    await regate(run);

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
  run.report.refusedPaths.push(...applied.refusedPaths);

  return typeof body.head === "number" && last.hub_seq < body.head;
}

async function refoldCutoffs(run: Run): Promise<void> {
  if (!staleCutoffs(run.deps.store, run.current.membership)) return;
  const verifier = verifierFor(run.current, run.keys);
  await applyRemoteEvents(run.root, { events: [], blobs: [] }, verifier);
}

async function recheckFiles(run: Run, verifier: Verifier): Promise<void> {
  const { store } = run.deps;
  if (recheckedFiles(store)) return;

  const events = malformedFileEvents(store);
  if (events.length > 0) {
    const applied = await applyRemoteEvents(
      run.root,
      { events, blobs: [], recheck: true },
      verifier,
    );

    run.report.refusedPaths.push(...applied.refusedPaths);
  }

  markRecheckedFiles(store);
}

async function pullEvents(run: Run): Promise<void> {
  const verifier = verifierFor(run.current, run.keys);
  await recheckFiles(run, verifier);
  while (await pullPage(run, verifier)) run.budget.check();
  await refoldCutoffs(run);
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
      const batch = fitting(run, storedEnvelopes(store, author, heads[author] ?? 0, BATCH));
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

async function reconcile(run: Run): Promise<void> {
  const { store } = run.deps;
  const incarnation = run.current.client.incarnation;
  const state = reconciling(store);
  run.report.reconciled = true;
  if (state?.phase === "pull" && state.incarnation === incarnation) return;

  setReconciling(store, { incarnation });
  await refoldCutoffs(run);
  await regate(run);
  authorDeletions(store, run.root);

  await pushHistory(run);
  await reuploadBlobs(run);
  await restoreTombstones(run);

  write(store, () => {
    setSyncMeta(store, { pulled: 0, incarnation });
    setReconcilingIn(store, { incarnation, phase: "pull" });
  });
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

async function start(deps: Deps, url: string, ms: number, grace?: number): Promise<Run> {
  const { store } = deps;
  const budget = grace === undefined ? new Budget(ms) : new Budget(ms, savedPace(store), grace);
  const device = syncMeta(store).device;

  let current: Enrolled;
  try {
    current = await enrolled(deps, url, true, undefined, budget.hard);
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
    report: emptyReport(),
  };
}

function shareOf(run: Run, fraction: number): number {
  return Date.now() + Math.max(0, run.budget.deadline - Date.now()) * fraction;
}

async function recordSessions(run: Run, env: NodeJS.ProcessEnv, cap: number): Promise<void> {
  try {
    await scanSessions(run.root, hostDirs(env), shareOf(run, 1 / 4));
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
  }

  const { budget } = run;
  const known = budget.bandwidth !== undefined;
  const bandwidth = budget.bandwidth ?? 0;
  const chunked = chunkTranscripts(run.deps.store, run.root, env, {
    deadline: shareOf(run, 1 / 3),
    bytes: cap,
    room: known ? () => ((budget.pushable() ?? 0) * 3) / 4 : undefined,
    perChunk: (bandwidth * budget.roundTrip) / 4,
    chunks: known ? undefined : 1,
  });

  const { refused } = chunked;
  if (refused !== undefined && chunked.made === 0)
    run.report.stuck ??= { kind: "chunk", ...refused };
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

async function leaseStep(run: Run): Promise<void> {
  const leaser = await leaserOf(run.current, (method, path, body) => call(run, method, path, body));
  if (leaser === undefined) return;

  try {
    run.report.leaseConflicts = await syncLeases(run.deps.store, leaser);
  } catch (error) {
    if (error instanceof Spent || error instanceof HubRefusal) return;
    if (!(error instanceof Offline) || Date.now() >= run.budget.deadline) throw error;
  }
}

export async function syncOnce(deps: Deps, url: string, options: SyncOptions): Promise<SyncReport> {
  const halted = stopped(deps.store);
  const device = syncMeta(deps.store).device;
  if (options.quiet && halted !== undefined && halted.device === device) return emptyReport();

  const began = Date.now();
  const root = rootOf(deps.store);
  if (!options.quiet) await recordWorkingCopies(root, copiesIn(root));

  const walked = walkFiles(deps.store, root, {
    deadline: began + options.budget / 2,
    bytes: options.quiet ? QUIET_WALK_BYTES : Number.POSITIVE_INFINITY,
  });

  const left = Math.max(0, options.budget - (Date.now() - began));
  const run = await start(deps, url, left, options.quiet ? undefined : GRACE);
  run.report.skipped = walked.skipped;

  try {
    await exchange(run, options);
  } catch (error) {
    if (options.quiet || !(error instanceof Spent)) throw error;
  } finally {
    const { measured } = run.budget;
    if (!options.quiet && measured !== undefined)
      savePace(deps.store, { rate: measured, slack: run.budget.overrun });
  }

  if (options.quiet) {
    finishSync(deps.store, new Date().toISOString(), run.report.reconciled);
    return run.report;
  }

  const { store } = deps;
  const { stuck } = run.report;
  const before = stuckItem(store);
  setStuckItem(store, stuck);

  const pending = backlog(store, run.current.device, [...run.report.heldBlobs]);
  const uncut = options.env === undefined ? 0 : uncutBytes(store, run.root, run.budget.hard);
  run.report.left = { ...pending, uncut };
  run.report.partial = run.budget.spent || pending.events + pending.blobs + uncut > 0;

  finishSync(store, new Date().toISOString(), run.report.reconciled && !run.report.partial);

  if (stuck !== undefined && before?.kind === stuck.kind && before.id === stuck.id) {
    if (run.budget.measured === undefined) forgetPace(store);
    throw tooSlow(stuck, run.budget.bandwidth);
  }

  return run.report;
}

async function exchange(run: Run, options: SyncOptions): Promise<void> {
  const { deps } = run;
  await refoldCutoffs(run);
  await regate(run);
  authorDeletions(deps.store, run.root);

  if (await diverged(run)) await reconcile(run);
  else if (syncMeta(deps.store).incarnation === undefined)
    write(deps.store, () =>
      setSyncMeta(deps.store, { incarnation: run.current.client.incarnation }),
    );

  run.current = await settle(deps, run.current);
  run.keys = new Keys(run.current.epochKeys);

  await pushOutbox(run);
  await pullEvents(run);
  await leaseStep(run);
  await fetchBlobs(run);

  const landings = landWorkingCopies(deps.store, run.root);
  const files = landFiles(deps.store, run.root, run.budget.deadline);
  run.report.landed = [...landings.landed, ...files.landed];
  run.report.conflicts = [...landings.conflicts, ...files.conflicts];
  run.report.refusedPaths.push(...files.refused);

  await publishHeld(run, options);

  if (!options.quiet && options.env !== undefined)
    await recordSessions(run, options.env, options.chunkBytes ?? CHUNK_BYTES);

  authorDeletions(deps.store, run.root);
  await pushOutbox(run);
  await sendDeletions(run);

  if (!options.quiet) await fetchTranscripts(run);
}

export function emptyReport(): SyncReport {
  return {
    pushedEvents: 0,
    pushedBlobs: 0,
    deletedBlobs: 0,
    heldBlobs: new Set(),
    pulledEvents: 0,
    pulledBlobs: 0,
    landed: [],
    conflicts: [],
    leaseConflicts: [],
    reconciled: false,
    refused: 0,
    skipped: [],
    refusedPaths: [],
    partial: false,
    left: { events: 0, blobs: 0, uncut: 0 },
  };
}

export function leftLine(report: SyncReport): string {
  const { events, blobs, uncut } = report.left;
  const { stuck } = report;
  const next = stuck === undefined ? "" : `, next ${stuck.kind} ${mebibytes(stuck.size)}`;
  return `left ${events} events, ${blobs} blobs, ${uncut} transcript bytes uncut${next}`;
}

export function summary(report: SyncReport): string {
  const conflicts = report.conflicts.length + report.leaseConflicts.length;
  return `pushed ${report.pushedEvents} events, ${report.pushedBlobs} blobs, pulled ${report.pulledEvents} events, ${report.pulledBlobs} blobs, conflicts ${conflicts}`;
}

export async function syncVerb(deps: Deps, url: string, options: SyncOptions): Promise<number> {
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

  for (const skipped of report.skipped)
    deps.out(
      skipped.reason === "symlink"
        ? `skipped symlink ${skipped.path}`
        : `skipped ${skipped.path}, larger than ${MAX_FILE_SIZE / 1024 / 1024} MiB`,
    );

  for (const conflict of report.conflicts)
    deps.out(
      isCopyKey(conflict.path)
        ? `conflict ${conflict.path}, run skills plans show --conflict ${conflict.project} ${conflict.plan}`
        : `conflict ${conflict.path}, kept the local file`,
    );

  for (const conflict of report.leaseConflicts)
    deps.out(
      `conflict ${conflict.project} ${conflict.plan} lease held by ${conflict.label}, run skills plans lease break ${conflict.project} ${conflict.plan}`,
    );

  for (const refused of report.refusedPaths)
    deps.out(`refused path ${refused.path}: ${refused.reason}`);

  if (report.refused > 0) deps.out(`refused ${report.refused} events that do not verify`);
  if (report.deletedBlobs > 0) deps.out(`deleted ${report.deletedBlobs} blobs`);
  if (report.heldBlobs.size > 0)
    deps.out(
      `held ${report.heldBlobs.size} blobs the hub refuses as too large, upgrade the hub to send them`,
    );

  deps.out(summary(report));

  if (report.partial) {
    deps.out(leftLine(report));
    return PARTIAL;
  }

  if (report.reconciled) deps.out("reconciled");
  return 0;
}

export async function reseed(deps: Deps, url: string): Promise<void> {
  const run = await start(deps, url, LONG_BUDGET);
  await reconcile(run);
  finishSync(deps.store, new Date().toISOString(), true);
  deps.out(`reseeded, ${run.report.pushedEvents} events, ${run.report.pushedBlobs} blobs`);
}

export async function pullToHead(deps: Deps, url: string): Promise<void> {
  const run = await start(deps, url, LONG_BUDGET);
  await pullEvents(run);
}

function enrollmentLine(store: Store): string | undefined {
  if (readLocal(store).checkpoint !== undefined) return undefined;
  const pending = readPending(store);
  return pending === undefined ? "not enrolled" : `joining as device ${pending.device}`;
}

export async function statusVerb(
  deps: Deps,
  url: string | undefined,
  network: string,
  tailnet?: Tailnet,
): Promise<number> {
  if (url === undefined) {
    deps.out("no hub configured");
    return 1;
  }

  const head = [
    `hub ${url} (${network})`,
    ...(tailnet?.kind === "up" ? [`tailnet ${tailnet.name}`] : []),
    ...(tailnet?.kind === "unknown" ? [`tailnet unread: ${tailnet.reason}`] : []),
  ];

  const unreachable =
    tailnet?.kind === "down"
      ? "offline: tailscale not connected"
      : tailnet?.kind === "missing"
        ? `offline: ${MISSING}`
        : undefined;

  const { store } = deps;
  const waiting = enrollmentLine(store);
  if (waiting !== undefined) {
    for (const line of [...head, ...(unreachable ? [unreachable] : []), waiting]) deps.out(line);
    return 0;
  }

  let incarnation = "-";
  let leases: number | undefined;
  let problem = unreachable;
  if (problem === undefined)
    try {
      const current = await enrolled(deps, url, false, undefined, Date.now() + SHORT_BUDGET);
      incarnation = current.client.incarnation;
      leases = (
        await hubLeases((method, path, body) =>
          current.client.call(method, path, body, current.signer),
        )
      ).size;
    } catch (error) {
      const said = sentence(error);
      if (said === undefined) throw error;

      const refused = error instanceof HubRefusal ? error.reason : undefined;
      if (error instanceof ForkDetected) problem = said;
      else if (refused === "device-revoked") problem = REVOKED;
      else if (refused === "device-unknown") problem = FORGOTTEN;
      else problem = `offline: ${said}`;
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
    ...head,
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
    ...(leases === undefined ? [] : [`leases ${leases}`]),
    `transcripts: ${tally.transcripts.pending} chunks pending, ${tally.transcripts.withheld} withheld`,
    `last sync ${lastSync(store) ?? "never"}`,
    ...(reconciled === undefined ? [] : [`reconciled ${reconciled}`]),
    ...(problem === undefined ? [] : [problem]),
  ];

  for (const line of lines) deps.out(line);
  return 0;
}

export function hubDeps(
  store: Store,
  env: NodeJS.ProcessEnv,
  out: (line: string) => void,
  fetcher: Fetch = fetch,
): Deps {
  return {
    store,
    keys: keyStore(env),
    connect: (url, deadline) => connect(url, networkOf(env), fetcher, undefined, deadline),
    now: Date.now,
    sleep: (ms) => Bun.sleep(ms),
    out,
  };
}

export type SyncOutcome =
  | { kind: "local" }
  | { kind: "busy" }
  | { kind: "failed"; message: string }
  | { kind: "offline"; reason: string }
  | { kind: "synced"; tally: SyncTally | undefined };

export type SyncTally = {
  readonly lastSync: string | undefined;
  readonly queue: number;
  readonly conflicts: number;
  readonly reconciled: string | undefined;
};

function tallyOf(store: Store): SyncTally {
  const { queue, conflicts } = counts(store);
  return { lastSync: lastSync(store), queue, conflicts, reconciled: reconciledAt(store) };
}

export async function shortSync(env: NodeJS.ProcessEnv, tally = false): Promise<SyncOutcome> {
  try {
    const url = hubSetting(env, "HUB_URL");
    if (url === undefined) return { kind: "local" };

    const root = plansDir(env);
    if (!existsSync(join(root, "plans.db"))) return { kind: "offline", reason: "not enrolled" };

    const locked = await tryLock(join(root, "hub.lock"), async (): Promise<SyncOutcome> => {
      const store = openStore(join(root, "plans.db"), { busyMs: SHORT_BUDGET / 4 });
      try {
        const waiting = enrollmentLine(store);
        if (waiting !== undefined) return { kind: "offline", reason: waiting };

        const halted = stopped(store);
        if (tally && halted !== undefined && halted.device === syncMeta(store).device)
          return { kind: "offline", reason: stopMessage(halted.device) };

        const deps = { ...hubDeps(store, env, () => {}), quiet: true };
        await syncOnce(deps, url, { budget: SHORT_BUDGET, publishQuarantine: false, quiet: true });

        return { kind: "synced", tally: tally ? tallyOf(store) : undefined };
      } finally {
        store.db.close();
      }
    });

    return locked.held ? { kind: "busy" } : locked.value;
  } catch (error) {
    const reason = sentence(error);
    if (reason !== undefined) return { kind: "offline", reason };
    return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
  }
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

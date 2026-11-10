import {
  CryptoRefusal,
  leaseKey,
  leasePlan,
  leaseTime,
  pinLive,
  randomId,
  subkey,
  type Claim,
  type Id,
  type LeaseHeld,
  type Subkey,
} from "skills-core";
import { leasesIn, recordConflict, recordHeld, recordReleased } from "../plans/leases.ts";
import { projectRows, projectedRows, write, type Store } from "../plans/store.ts";
import { HubRefusal, type Method } from "./client.ts";
import { Offline } from "./network.ts";
import { enrolled, EnrollRefusal, labelOf, sentence, type Deps, type Enrolled } from "./enroll.ts";
import { epochKeys, ForkDetected, readLocal, verifiedLocal } from "./vault.ts";

const MINUTE = 60 * 1000;

const HOUR = 60 * MINUTE;

const DAY = 24 * HOUR;

export const DOING_TTL = DAY;

export const LEASE_BUDGET = 5_000;

const RENEW_UNDER = 12 * HOUR;

const ORPHAN_AGE = 10 * MINUTE;

export const PIN_DEFAULT = "7d";

const PIN_MAX = 30 * DAY;

const RENEWED = new Set(["DOING", "BLOCKED"]);

const KEPT = new Set(["DOING", "BLOCKED", "REVIEW"]);

export type HubLease = {
  readonly key: string;
  readonly holder: string;
  readonly token: string;
  readonly acquired: number;
  readonly expires: number;
  readonly pinned: boolean;
};

export type Call = (
  method: Method,
  path: string,
  body?: unknown,
) => Promise<Record<string, unknown>>;

export type Leaser = {
  readonly device: string;
  readonly call: Call;
  readonly leases: Subkey<"leases">;
  readonly label: (device: string) => Promise<string>;
};

export type Taken =
  | { kind: "taken"; lease: HubLease; fresh: boolean }
  | { kind: "held"; holder: string; acquired: number };

export type LeaseConflictLine = { project: string; plan: string; label: string };

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function heldLine(label: string, acquired: string): string {
  return `held by ${label} since ${leaseTime(acquired)}`;
}

function hubLease(value: unknown): HubLease | undefined {
  if (typeof value !== "object" || value === null) return undefined;

  const { key, holder, token, acquired, expires, pinned } = value as Record<string, unknown>;
  if (typeof key !== "string" || typeof holder !== "string" || typeof token !== "string")
    return undefined;

  if (typeof acquired !== "number" || typeof expires !== "number" || typeof pinned !== "boolean")
    return undefined;

  return { key, holder, token, acquired, expires, pinned };
}

function answered(value: unknown): HubLease {
  const lease = hubLease(value);
  if (lease === undefined) throw new Offline("the hub sent a lease that does not parse");
  return lease;
}

export async function hubLeases(call: Call): Promise<Map<string, HubLease>> {
  const body = await call("GET", "/v1/leases");
  if (!Array.isArray(body.leases)) throw new Offline("the hub sent no lease list");
  return new Map(body.leases.map(answered).map((lease) => [lease.key, lease]));
}

async function once<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (!(error instanceof Offline)) throw error;
    return attempt();
  }
}

type Put = { operation: string; token: string | null; ttl: number; pinned: boolean };

async function put(call: Call, key: string, body: Put): Promise<HubLease> {
  return answered(await once(() => call("PUT", `/v1/leases/${key}`, body)));
}

export async function removeLease(
  call: Call,
  lease: HubLease,
  mode: "release" | "break",
): Promise<void> {
  const body = { operation: randomId(), token: lease.token, mode };
  await once(() => call("DELETE", `/v1/leases/${lease.key}`, body));
}

export async function keyFor(leaser: Leaser, project: string, plan: string): Promise<string> {
  return leaseKey(leaser.leases, project, plan);
}

export async function take(
  leaser: Leaser,
  key: string,
  wanted: {
    ttl: number;
    pinned: boolean;
    operation?: string;
    ended?: (lease: HubLease) => boolean;
  },
): Promise<Taken> {
  for (let attempt = 0; ; attempt++) {
    let found = (await hubLeases(leaser.call)).get(key);
    if (found !== undefined && found.holder !== leaser.device)
      return { kind: "held", holder: found.holder, acquired: found.acquired };

    if (found !== undefined && wanted.ended?.(found) === true) {
      await removeLease(leaser.call, found, "release");
      found = undefined;
    }

    const operation = attempt === 0 && found === undefined ? wanted.operation : undefined;
    const body = {
      operation: operation ?? randomId(),
      token: found === undefined ? null : found.token,
      ttl: wanted.ttl,
      pinned: wanted.pinned,
    };

    try {
      const lease = await put(leaser.call, key, body);
      if (attempt === 0 && wanted.ended?.(lease) === true) continue;
      return { kind: "taken", lease, fresh: found === undefined };
    } catch (error) {
      if (!(error instanceof HubRefusal)) throw error;

      const { holder, acquired } = error.detail;
      if (error.reason === "lease-held" && typeof holder === "string")
        return { kind: "held", holder, acquired: typeof acquired === "number" ? acquired : 0 };

      const stale = error.reason === "lease-token" || error.reason === "operation-reused";
      if (!stale || attempt > 0) throw error;
    }
  }
}

export function heldOf(lease: HubLease, label: string): LeaseHeld {
  return {
    device: lease.holder,
    label,
    acquired: iso(lease.acquired),
    expires: iso(lease.expires),
    pinned: lease.pinned,
    provisional: false,
    operation: null,
  };
}

export async function leaserOf(current: Enrolled, call: Call): Promise<Leaser | undefined> {
  const founding = current.epochKeys.get(1);
  if (founding === undefined) return undefined;

  return {
    device: current.device,
    call,
    leases: await subkey(founding, "leases"),
    label: (device) => labelOf(current.membership, current.epochKeys, device as Id),
  };
}

export function untrusted(error: unknown): boolean {
  return error instanceof ForkDetected || error instanceof CryptoRefusal;
}

export function offline(error: unknown): boolean {
  if (error instanceof Offline || untrusted(error)) return true;
  return error instanceof HubRefusal && (error.status >= 500 || error.reason === "protocol");
}

export function refusalOf(error: unknown): string {
  return sentence(error) ?? (error instanceof Error ? error.message : String(error));
}

export async function openLeaser(deps: Deps, url: string, ms = LEASE_BUDGET): Promise<Leaser> {
  const deadline = Date.now() + ms;
  const current = await enrolled(deps, url, false, undefined, deadline);
  const call: Call = (method, path, body) => {
    if (Date.now() > deadline) throw new Offline("the hub did not answer in time");
    return current.client.call(method, path, body, current.signer);
  };

  const leaser = await leaserOf(current, call);
  if (leaser === undefined) throw new EnrollRefusal("this device holds no key for the first epoch");
  return leaser;
}

export async function ownLabel(deps: Deps): Promise<{ device: string; label: string } | undefined> {
  const local = readLocal(deps.store);
  const membership = await verifiedLocal(local);
  if (membership === undefined || local.device === undefined) return undefined;

  const keys = await deps.keys.read(local.device);
  const held =
    keys === "not enrolled" ? new Map() : await epochKeys(membership, local.device, keys.wrap);

  return { device: local.device, label: await labelOf(membership, held, local.device) };
}

export function endedHere(store: Store, project: string, plan: string, lease: HubLease): boolean {
  const leases = leasesIn(store, project).get(leasePlan(project, plan));
  return leases?.ended.has(`${lease.holder} ${iso(lease.acquired)}`) === true;
}

export function ownClaim(
  store: Store,
  project: string,
  plan: string,
  device: string,
): Claim | undefined {
  return leasesIn(store, project).get(leasePlan(project, plan))?.claims.get(device);
}

function planOf(name: string): { project: string; plan: string } {
  const cut = name.lastIndexOf("/");
  return { project: name.slice(0, cut), plan: name.slice(cut + 1) };
}

function statuses(store: Store): Map<string, string> {
  const found = new Map<string, string>();
  for (const [project, rows] of projectedRows(store))
    for (const row of rows.values()) found.set(leasePlan(project, row.id), row.status);

  return found;
}

type Target = { readonly project: string; readonly plan: string; readonly key: string };

type Step = {
  readonly store: Store;
  readonly leaser: Leaser;
  readonly hub: ReadonlyMap<string, HubLease>;
  readonly now: number;
  readonly conflicts: LeaseConflictLine[];
};

function unchanged(step: Step, target: Target, claim: Claim): boolean {
  const now = ownClaim(step.store, target.project, target.plan, step.leaser.device);
  return (
    now !== undefined &&
    now.conflict === null &&
    now.acquired === claim.acquired &&
    now.expires === claim.expires &&
    now.pinned === claim.pinned
  );
}

function adopted(step: Step, target: Target, lease: HubLease): boolean {
  const now = ownClaim(step.store, target.project, target.plan, step.leaser.device);
  return now?.acquired === iso(lease.acquired);
}

function statusOf(step: Step, target: Target): string | undefined {
  return projectRows(step.store, target.project).find((row) => row.id === target.plan)?.status;
}

async function conflictWith(
  step: Step,
  target: Target,
  claim: Claim,
  holder: string,
  holderAcquired: number,
): Promise<void> {
  const label = await step.leaser.label(holder);
  const recorded = write(step.store, () => {
    if (!unchanged(step, target, claim)) return false;

    recordConflict(step.store, Date.now(), target.project, target.plan, {
      device: step.leaser.device,
      acquired: claim.acquired,
      holder,
      holderAcquired: iso(holderAcquired),
      holderLabel: label,
    });

    return true;
  });

  if (recorded) step.conflicts.push({ project: target.project, plan: target.plan, label });
}

async function hold(step: Step, target: Target, claim: Claim, taken: Taken): Promise<void> {
  if (taken.kind === "held") return conflictWith(step, target, claim, taken.holder, taken.acquired);

  const held = heldOf(taken.lease, await step.leaser.label(taken.lease.holder));
  const { lease } = taken;
  const kept = write(step.store, () => {
    if (unchanged(step, target, claim))
      recordHeld(step.store, Date.now(), target.project, target.plan, held);
    else if (!adopted(step, target, lease)) return false;

    return true;
  });

  if (!kept && taken.fresh) await removeLease(step.leaser.call, lease, "release");
}

async function acquire(step: Step, target: Target, claim: Claim, ttl: number): Promise<void> {
  const operation = claim.provisional ? (claim.operation ?? undefined) : undefined;
  const pinned = pinLive(claim, step.now);
  const ended = (lease: HubLease) => endedHere(step.store, target.project, target.plan, lease);
  const taken = await take(step.leaser, target.key, { ttl, pinned, operation, ended });
  await hold(step, target, claim, taken);
}

async function adopt(step: Step, target: Target, claim: Claim, found: HubLease): Promise<boolean> {
  if (iso(found.acquired) === claim.acquired) return false;

  if (endedHere(step.store, target.project, target.plan, found)) {
    await removeLease(step.leaser.call, found, "release");
    return false;
  }

  await hold(step, target, claim, { kind: "taken", lease: found, fresh: false });
  return true;
}

async function keepDoing(step: Step, target: Target, claim: Claim): Promise<void> {
  const found = step.hub.get(target.key);
  if (found === undefined) return acquire(step, target, claim, DOING_TTL);
  if (found.holder !== step.leaser.device)
    return conflictWith(step, target, claim, found.holder, found.acquired);

  if (iso(found.acquired) !== claim.acquired) {
    if (!(await adopt(step, target, claim, found))) await acquire(step, target, claim, DOING_TTL);
    return;
  }

  const pinned = pinLive(claim, step.now);
  const unpin = claim.pinned && !pinned;
  if (!unpin && found.expires - step.now >= RENEW_UNDER) return;

  const body = { operation: randomId(), token: found.token, ttl: DOING_TTL, pinned };
  const renewed = await put(step.leaser.call, target.key, body);
  if (unpin) await hold(step, target, claim, { kind: "taken", lease: renewed, fresh: false });
}

async function keepPin(step: Step, target: Target, claim: Claim): Promise<void> {
  const found = step.hub.get(target.key);
  if (found !== undefined && found.holder !== step.leaser.device)
    return conflictWith(step, target, claim, found.holder, found.acquired);

  const left = Math.max(1_000, Date.parse(claim.expires) - step.now);
  if (found === undefined) await acquire(step, target, claim, left);
  else if (iso(found.acquired) !== claim.acquired && !(await adopt(step, target, claim, found)))
    await acquire(step, target, claim, left);
}

async function releaseClaim(step: Step, target: Target, claim: Claim): Promise<void> {
  const self = step.leaser.device;
  const recorded = write(step.store, () => {
    const status = statusOf(step, target);
    if (!unchanged(step, target, claim) || (status !== undefined && KEPT.has(status))) return false;

    recordReleased(step.store, Date.now(), target.project, target.plan, {
      device: self,
      acquired: claim.acquired,
      by: self,
      mode: "release",
    });

    return true;
  });

  const found = step.hub.get(target.key);
  if (recorded && found?.holder === self && found.acquired <= Date.parse(claim.acquired))
    await removeLease(step.leaser.call, found, "release");
}

async function releaseGone(step: Step, target: Target, gone: string): Promise<void> {
  const found = step.hub.get(target.key);
  if (found?.holder === step.leaser.device && found.acquired <= Date.parse(gone))
    await removeLease(step.leaser.call, found, "release");
}

const CLOSED = new Set(["DONE", "DROPPED"]);
async function settleClaim(
  step: Step,
  target: Target,
  claim: Claim | undefined,
  gone: string | undefined,
  status: string | undefined,
): Promise<void> {
  if (claim === undefined) {
    if (gone !== undefined) await releaseGone(step, target, gone);
    return;
  }

  if (claim.conflict !== null) return;

  const closed = status === undefined || CLOSED.has(status);
  if (claim.provisional && !closed) await acquire(step, target, claim, DOING_TTL);
  else if (closed) await releaseClaim(step, target, claim);
  else if (RENEWED.has(status)) await keepDoing(step, target, claim);
  else if (pinLive(claim, step.now)) await keepPin(step, target, claim);
  else if (!KEPT.has(status)) await releaseClaim(step, target, claim);
}

export async function syncLeases(store: Store, leaser: Leaser): Promise<LeaseConflictLine[]> {
  const plans = leasesIn(store);
  const step: Step = {
    store,
    leaser,
    hub: await hubLeases(leaser.call),
    now: Date.now(),
    conflicts: [],
  };

  const self = leaser.device;
  const holding = [...step.hub.values()].some((lease) => lease.holder === self);
  if (plans.size === 0 && !holding) return [];

  const status = statuses(store);
  const known = new Set<string>();
  for (const [name, leases] of plans) {
    const claim = leases.claims.get(self);
    const gone = leases.released.get(self);
    if (claim === undefined && (gone === undefined || !holding)) continue;

    const { project, plan } = planOf(name);
    const target = { project, plan, key: await keyFor(leaser, project, plan) };
    if (claim !== undefined) known.add(target.key);

    try {
      await settleClaim(step, target, claim, gone, status.get(name));
    } catch (error) {
      if (!(error instanceof HubRefusal)) throw error;
    }
  }

  const orphans = [...step.hub.values()].filter(
    (lease) =>
      lease.holder === self && !known.has(lease.key) && step.now - lease.acquired > ORPHAN_AGE,
  );

  if (orphans.length === 0) return step.conflicts;

  const claimed = new Set<string>();
  for (const [name, leases] of leasesIn(store)) {
    const claim = leases.claims.get(self);
    if (claim === undefined) continue;

    const { project, plan } = planOf(name);
    claimed.add(`${await keyFor(leaser, project, plan)} ${claim.acquired}`);
  }

  for (const lease of orphans)
    if (!claimed.has(`${lease.key} ${iso(lease.acquired)}`))
      await removeLease(leaser.call, lease, "release");

  return step.conflicts;
}

export function pinDuration(value: string): number | string {
  const found = /^([1-9][0-9]*)(h|d)$/.exec(value);
  if (found === null) return `--for takes hours or days, such as 12h or 3d, not ${value}`;

  const lasts = Number(found[1]) * (found[2] === "d" ? DAY : HOUR);
  return lasts > PIN_MAX ? "at most 30d" : lasts;
}

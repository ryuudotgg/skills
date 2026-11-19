import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  isClosed,
  leasePlan,
  leaseState,
  leaseTime,
  moveRefusal,
  randomId,
  type LeaseHeld,
  type PlanLeases,
} from "skills-core";
import { openPlansStore } from "../plans/commit.ts";
import { plansDir } from "../plans/index-tsv.ts";
import { leasesIn, recordHeld, recordReleased } from "../plans/leases.ts";
import { projectMoves, projectRows, write, type Store } from "../plans/store.ts";
import { HubRefusal } from "./client.ts";
import { hubSetting } from "./network.ts";
import type { Deps } from "./enroll.ts";
import {
  DOING_TTL,
  endedHere,
  heldLine,
  heldOf,
  hubLeases,
  iso,
  keyFor,
  LEASE_BUDGET,
  offline,
  openLeaser,
  openLeasers,
  ownClaim,
  ownLabel,
  pinDuration,
  refusalOf,
  removeLease,
  spent,
  take,
  untrusted,
  type HubLease,
  type Leaser,
  type Leasers,
  type Sent,
} from "./leases.ts";
import { hubDeps } from "./sync.ts";
import { readLocal } from "./vault.ts";

export type StartLease =
  | { kind: "none"; note?: string }
  | { kind: "taken"; held: LeaseHeld }
  | { kind: "provisional"; held: LeaseHeld; offline: boolean; note?: string }
  | { kind: "refused"; reason: string };

type Self = { device: string; label: string };

type Session =
  | { kind: "off" }
  | { kind: "offline"; deps: Deps; self: Self; reachable: boolean; note?: string }
  | { kind: "online"; deps: Deps; url: string; leasers: Leasers }
  | { kind: "refused"; reason: string };

type Away = Exclude<Session, { kind: "online" }>;

type Ran<T> =
  | { kind: "done"; value: T }
  | { kind: "failed"; error: unknown; deps: Deps }
  | { kind: "away"; session: Away };

function refused409(error: unknown): boolean {
  return error instanceof HubRefusal && error.status === 409;
}

export type LeaseSession = {
  held(project: string, ids: readonly string[]): Promise<Map<string, string>>;
  start(project: string, id: string): Promise<StartLease>;
  abandon(): Promise<void>;
  close(): void;
};

async function open(
  env: NodeJS.ProcessEnv,
  budget: number,
): Promise<{ store?: Store; session: Session }> {
  const url = hubSetting(env, "HUB_URL");
  const root = plansDir(env);
  if (url === undefined || !existsSync(join(root, "plans.db"))) return { session: { kind: "off" } };

  const store = await openPlansStore(root);
  if (readLocal(store).checkpoint === undefined) return { store, session: { kind: "off" } };

  const deps = { ...hubDeps(store, env, () => {}), quiet: true };
  return { store, session: await connect(deps, url, budget) };
}

async function connect(deps: Deps, url: string, budget: number): Promise<Session> {
  try {
    return { kind: "online", deps, url, leasers: await openLeasers(deps, url, budget) };
  } catch (error) {
    if (refused409(error)) return { kind: "refused", reason: refusalOf(error) };
    return offlineSession(deps, error);
  }
}

async function offlineSession(deps: Deps, error: unknown): Promise<Away> {
  const self = await ownLabel(deps);
  if (self === undefined) return { kind: "off" };
  return { kind: "offline", deps, self, reachable: !offline(error), note: refusalOf(error) };
}

async function budgeted<T>(
  leasers: Leasers,
  budget: number,
  operation: (leaser: Leaser) => Promise<T>,
): Promise<T> {
  for (let retried = false; ; retried = true) {
    const deadline = Date.now() + budget;
    try {
      return await operation(await leasers.at(deadline));
    } catch (error) {
      if (retried || !spent(deadline, error)) throw error;
    }
  }
}

async function heldBy(
  leaser: Leaser,
  project: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const leases = await hubLeases(leaser.call);
  for (const id of ids) {
    const lease = leases.get(await keyFor(leaser, project, id));
    if (lease !== undefined && lease.holder !== leaser.device)
      found.set(id, heldLine(await leaser.label(lease.holder), iso(lease.acquired)));
  }

  return found;
}

function provisional(self: Self, operation: string, reachable: boolean, note?: string): StartLease {
  const now = Date.now();
  return {
    kind: "provisional",
    offline: !reachable,
    note,
    held: {
      device: self.device,
      label: self.label,
      acquired: iso(now),
      expires: iso(now + DOING_TTL),
      pinned: false,
      provisional: true,
      operation,
    },
  };
}

export async function leaseSession(
  env: NodeJS.ProcessEnv,
  budget = LEASE_BUDGET,
): Promise<LeaseSession> {
  const { store, session } = await open(env, budget);
  const fresh: { project: string; id: string; lease: HubLease }[] = [];
  let current = session;

  const onHub = async <T>(operation: (leaser: Leaser) => Promise<T>): Promise<Ran<T>> => {
    const now = current;
    if (now.kind !== "online") return { kind: "away", session: now };

    try {
      return { kind: "done", value: await budgeted(now.leasers, budget, operation) };
    } catch (error) {
      return { kind: "failed", error, deps: now.deps };
    }
  };

  const startAway = (away: Away, project: string, id: string, operation: string): StartLease => {
    if (away.kind === "off") return { kind: "none" };
    if (away.kind === "refused") return { kind: "refused", reason: away.reason };

    const own = store && ownClaim(store, project, id, away.self.device);
    if (own === undefined || own.provisional)
      return provisional(away.self, operation, away.reachable, away.note);

    const note = away.note === undefined ? "kept, the hub is unreachable" : `kept, ${away.note}`;
    return { kind: "none", note };
  };

  const startOn = async (
    leaser: Leaser,
    project: string,
    id: string,
    operation: string,
    sent: Sent,
  ): Promise<StartLease> => {
    const ended = (lease: HubLease) => store !== undefined && endedHere(store, project, id, lease);
    const key = await keyFor(leaser, project, id);
    const taken = await take(leaser, key, {
      ttl: DOING_TTL,
      pinned: false,
      operation,
      ended,
      sent,
    });

    if (taken.kind === "held")
      return {
        kind: "refused",
        reason: heldLine(await leaser.label(taken.holder), iso(taken.acquired)),
      };

    if (taken.fresh) fresh.push({ project, id, lease: taken.lease });
    return { kind: "taken", held: heldOf(taken.lease, await leaser.label(leaser.device)) };
  };

  return {
    async held(project, ids) {
      const ran = await onHub((leaser) => heldBy(leaser, project, ids));
      if (ran.kind === "done") return ran.value;

      if (ran.kind === "failed" && offline(ran.error))
        current = await offlineSession(ran.deps, ran.error);

      return new Map();
    },
    async start(project, id) {
      const operation = randomId();
      const sent: Sent = {};

      const ran = await onHub((leaser) => startOn(leaser, project, id, operation, sent));
      if (ran.kind === "done") return ran.value;
      if (ran.kind === "away") return startAway(ran.session, project, id, operation);
      if (refused409(ran.error)) return { kind: "refused", reason: refusalOf(ran.error) };

      const down = await offlineSession(ran.deps, ran.error);
      current = down;
      return startAway(down, project, id, operation);
    },
    async abandon() {
      const taken = fresh.splice(0);
      if (taken.length === 0 || store === undefined || session.kind !== "online") return;

      let leaser: Leaser;
      try {
        leaser = await openLeaser(session.deps, session.url);
      } catch {
        return;
      }

      for (const { project, id, lease } of taken)
        if (ownClaim(store, project, id, leaser.device)?.acquired !== iso(lease.acquired))
          try {
            await removeLease(leaser.call, lease, "release");
          } catch {}
    },
    close() {
      store?.db.close();
    },
  };
}

export type PinLine = { id: string; line: string; ok: boolean };

function unreached(error: unknown): string {
  return offline(error) && !untrusted(error) ? "hub offline" : refusalOf(error);
}

function movingAway(
  store: Store,
  project: string,
  row: { id: string; status: string },
  self: string,
): string | undefined {
  if (row.status !== "DOING") return undefined;
  const moved = projectMoves(store, project).get(row.id);
  return moved && moveRefusal(row.id, moved, self);
}

export async function pinPlans(
  project: string,
  ids: readonly string[],
  lasts: string,
  env: NodeJS.ProcessEnv,
  budget = LEASE_BUDGET,
): Promise<PinLine[]> {
  const refuse = (id: string, reason: string) => ({
    id,
    line: `pin ${id} refused: ${reason}`,
    ok: false,
  });

  const ttl = pinDuration(lasts);
  if (typeof ttl === "string") return ids.map((id) => refuse(id, ttl));

  const url = hubSetting(env, "HUB_URL");
  if (url === undefined) return ids.map((id) => refuse(id, "no hub configured"));

  const store = await openPlansStore(plansDir(env));
  try {
    const rows = new Map(projectRows(store, project).map((row) => [row.id, row]));

    if (readLocal(store).checkpoint === undefined)
      return ids.map((id) => refuse(id, "this store is not enrolled"));

    const deps = { ...hubDeps(store, env, () => {}), quiet: true };

    let leasers: Leasers;
    try {
      leasers = await openLeasers(deps, url, budget);
    } catch (error) {
      const reason = unreached(error);
      return ids.map((id) => refuse(id, reason));
    }

    const pin = async (fresh: Leaser, id: string, sent: Sent): Promise<PinLine> => {
      const ended = (lease: HubLease) => endedHere(store, project, id, lease);
      const key = await keyFor(fresh, project, id);
      const taken = await take(fresh, key, {
        ttl,
        pinned: true,
        operation: randomId(),
        ended,
        sent,
      });

      if (taken.kind === "held")
        return refuse(id, heldLine(await fresh.label(taken.holder), iso(taken.acquired)));

      const held = heldOf(taken.lease, await fresh.label(fresh.device));
      const refusal = write(store, () => {
        const now = projectRows(store, project).find((entry) => entry.id === id);
        const standing =
          now === undefined || isClosed(now.status)
            ? `${id} is ${now?.status ?? "gone"}`
            : movingAway(store, project, now, fresh.device);

        if (standing === undefined) recordHeld(store, Date.now(), project, id, held);
        return standing;
      });

      if (refusal !== undefined) {
        if (taken.fresh) await removeLease(fresh.call, taken.lease, "release");
        return refuse(id, refusal);
      }

      return { id, line: `pinned ${id} until ${leaseTime(held.expires)}`, ok: true };
    };

    const lines: PinLine[] = [];
    for (const id of ids) {
      const row = rows.get(id);
      if (row === undefined) {
        lines.push(refuse(id, `no row ${id} in ${project}`));
        continue;
      }

      if (isClosed(row.status)) {
        lines.push(refuse(id, `${id} is ${row.status}`));
        continue;
      }

      const moving = movingAway(store, project, row, leasers.device);
      if (moving) {
        lines.push(refuse(id, moving));
        continue;
      }

      const sent: Sent = {};

      try {
        lines.push(await budgeted(leasers, budget, (fresh) => pin(fresh, id, sent)));
      } catch (error) {
        lines.push(refuse(id, unreached(error)));
      }
    }

    return lines;
  } finally {
    store.db.close();
  }
}

export type BreakResult = { ok: true; line: string } | { ok: false; reason: string };

type BreakTarget = { device: string; acquired: string[] };

function breakTarget(
  leases: PlanLeases | undefined,
  self: string,
  found: HubLease | undefined,
): BreakTarget | undefined {
  const claims = [...(leases?.claims.values() ?? [])];
  const against =
    leases?.claims.get(self)?.conflict?.device ??
    claims.find((claim) => claim.conflict?.device === self)?.device;

  const device = against ?? found?.holder ?? stateHolder(leases, self);
  if (device === undefined) return undefined;

  const acquired = new Set<string>();
  const local = leases?.claims.get(device)?.acquired;
  if (local !== undefined) acquired.add(local);

  const conflict = leases?.claims.get(self)?.conflict;
  if (conflict?.device === device) acquired.add(conflict.acquired);
  if (found?.holder === device) acquired.add(iso(found.acquired));

  return { device, acquired: [...acquired] };
}

function stateHolder(leases: PlanLeases | undefined, self: string): string | undefined {
  const state = leaseState(leases, self, Date.now());
  return state.kind === "held" ? state.claim.device : undefined;
}

export async function breakLease(
  project: string,
  id: string,
  env: NodeJS.ProcessEnv,
): Promise<BreakResult> {
  const url = hubSetting(env, "HUB_URL");
  if (url === undefined) return { ok: false, reason: "no hub configured" };

  const store = await openPlansStore(plansDir(env));
  try {
    if (readLocal(store).checkpoint === undefined)
      return { ok: false, reason: "this store is not enrolled" };

    const deps = { ...hubDeps(store, env, () => {}), quiet: true };
    const failed = (error: unknown) => ({ ok: false as const, reason: unreached(error) });

    let leaser: Leaser;
    let found: HubLease | undefined;
    try {
      leaser = await openLeaser(deps, url);
      found = (await hubLeases(leaser.call)).get(await keyFor(leaser, project, id));
    } catch (error) {
      return failed(error);
    }

    const leases = leasesIn(store, project).get(leasePlan(project, id));
    const target = breakTarget(leases, leaser.device, found);
    if (target === undefined || target.acquired.length === 0)
      return { ok: false, reason: `no lease on ${project} ${id}` };

    if (found !== undefined && found.holder === target.device)
      try {
        await removeLease(leaser.call, found, "break");
      } catch (error) {
        return failed(error);
      }

    write(store, () => {
      for (const acquired of target.acquired)
        recordReleased(store, Date.now(), project, id, {
          device: target.device,
          acquired,
          by: leaser.device,
          mode: "break",
        });
    });

    return { ok: true, line: `broke lease of ${await leaser.label(target.device)}` };
  } finally {
    store.db.close();
  }
}

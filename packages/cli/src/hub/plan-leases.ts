import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  leasePlan,
  leaseState,
  leaseTime,
  randomId,
  type LeaseHeld,
  type PlanLeases,
} from "skills-core";
import { openPlansStore } from "../plans/commit.ts";
import { plansDir } from "../plans/index-tsv.ts";
import { leasesIn, recordHeld, recordReleased } from "../plans/leases.ts";
import { projectRows, write, type Store } from "../plans/store.ts";
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
  offline,
  openLeaser,
  ownClaim,
  ownLabel,
  pinDuration,
  refusalOf,
  removeLease,
  take,
  type HubLease,
  type Leaser,
} from "./leases.ts";
import { hubDeps } from "./sync.ts";
import { readLocal } from "./vault.ts";

export type StartLease =
  | { kind: "none"; note?: string }
  | { kind: "taken"; held: LeaseHeld }
  | { kind: "provisional"; held: LeaseHeld; note?: string }
  | { kind: "refused"; reason: string };

type Self = { device: string; label: string };

type Session =
  | { kind: "off" }
  | { kind: "offline"; deps: Deps; self: Self; note?: string }
  | { kind: "online"; deps: Deps; url: string; leaser: Leaser }
  | { kind: "skip"; note: string }
  | { kind: "refused"; reason: string };

function refused409(error: unknown): boolean {
  return error instanceof HubRefusal && error.status === 409;
}

export type LeaseSession = {
  held(project: string, ids: readonly string[]): Promise<Map<string, string>>;
  start(project: string, id: string): Promise<StartLease>;
  abandon(): Promise<void>;
  close(): void;
};

async function open(env: NodeJS.ProcessEnv): Promise<{ store?: Store; session: Session }> {
  const url = hubSetting(env, "HUB_URL");
  const root = plansDir(env);
  if (url === undefined || !existsSync(join(root, "plans.db"))) return { session: { kind: "off" } };

  const store = await openPlansStore(root);
  if (readLocal(store).checkpoint === undefined) return { store, session: { kind: "off" } };

  const deps = { ...hubDeps(store, env, () => {}), quiet: true };
  try {
    return { store, session: { kind: "online", deps, url, leaser: await openLeaser(deps, url) } };
  } catch (error) {
    if (refused409(error)) return { store, session: { kind: "refused", reason: refusalOf(error) } };
    if (!offline(error)) return { store, session: { kind: "skip", note: refusalOf(error) } };
    return { store, session: await offlineSession(deps, error) };
  }
}

async function offlineSession(deps: Deps, error: unknown): Promise<Session> {
  const self = await ownLabel(deps);
  const note = refusalOf(error);
  return self === undefined ? { kind: "off" } : { kind: "offline", deps, self, note };
}

function provisional(self: Self, operation: string, note?: string): StartLease {
  const now = Date.now();
  return {
    kind: "provisional",
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

export async function leaseSession(env: NodeJS.ProcessEnv): Promise<LeaseSession> {
  const { store, session } = await open(env);
  const fresh: { project: string; id: string; lease: HubLease }[] = [];
  let current = session;

  const offlineStart = (
    offline: Session & { kind: "offline" },
    project: string,
    id: string,
    operation: string,
  ) => {
    const own = store && ownClaim(store, project, id, offline.self.device);
    if (own === undefined || own.provisional)
      return provisional(offline.self, operation, offline.note);

    const note =
      offline.note === undefined ? "kept, the hub is unreachable" : `kept, ${offline.note}`;

    return { kind: "none", note } as const;
  };

  return {
    async held(project, ids) {
      const found = new Map<string, string>();
      if (current.kind !== "online") return found;

      const { leaser } = current;
      try {
        const leases = await hubLeases(leaser.call);
        for (const id of ids) {
          const lease = leases.get(await keyFor(leaser, project, id));
          if (lease !== undefined && lease.holder !== leaser.device)
            found.set(id, heldLine(await leaser.label(lease.holder), iso(lease.acquired)));
        }
      } catch (error) {
        if (offline(error)) current = await offlineSession(current.deps, error);
      }

      return found;
    },
    async start(project, id) {
      if (current.kind === "off") return { kind: "none" };
      if (current.kind === "skip") return { kind: "none", note: current.note };
      if (current.kind === "refused") return { kind: "refused", reason: current.reason };
      if (current.kind === "offline") return offlineStart(current, project, id, randomId());

      const { leaser, deps } = current;
      const operation = randomId();
      const ended = (lease: HubLease) =>
        store !== undefined && endedHere(store, project, id, lease);

      try {
        const key = await keyFor(leaser, project, id);
        const taken = await take(leaser, key, {
          ttl: DOING_TTL,
          pinned: false,
          operation,
          ended,
        });

        if (taken.kind === "held")
          return {
            kind: "refused",
            reason: heldLine(await leaser.label(taken.holder), iso(taken.acquired)),
          };

        if (taken.fresh) fresh.push({ project, id, lease: taken.lease });
        return { kind: "taken", held: heldOf(taken.lease, await leaser.label(leaser.device)) };
      } catch (error) {
        if (!offline(error))
          return refused409(error)
            ? { kind: "refused", reason: refusalOf(error) }
            : { kind: "none", note: refusalOf(error) };

        current = await offlineSession(deps, error);
        return current.kind === "offline"
          ? offlineStart(current, project, id, operation)
          : { kind: "none" };
      }
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

const CLOSED = new Set(["DONE", "DROPPED"]);
export async function pinPlans(
  project: string,
  ids: readonly string[],
  lasts: string,
  env: NodeJS.ProcessEnv,
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

    let leaser: Leaser;
    try {
      leaser = await openLeaser(deps, url);
    } catch (error) {
      const reason = offline(error) ? "hub offline" : refusalOf(error);
      return ids.map((id) => refuse(id, reason));
    }

    const lines: PinLine[] = [];
    for (const id of ids) {
      const row = rows.get(id);
      if (row === undefined) {
        lines.push(refuse(id, `no row ${id} in ${project}`));
        continue;
      }

      if (CLOSED.has(row.status)) {
        lines.push(refuse(id, `${id} is ${row.status}`));
        continue;
      }

      try {
        const ended = (lease: HubLease) => endedHere(store, project, id, lease);
        const key = await keyFor(leaser, project, id);
        const taken = await take(leaser, key, { ttl, pinned: true, ended });
        if (taken.kind === "held") {
          lines.push(refuse(id, heldLine(await leaser.label(taken.holder), iso(taken.acquired))));
          continue;
        }

        const held = heldOf(taken.lease, await leaser.label(leaser.device));
        const status = write(store, () => {
          const now = projectRows(store, project).find((entry) => entry.id === id)?.status;
          if (now !== undefined && !CLOSED.has(now))
            recordHeld(store, Date.now(), project, id, held);

          return now;
        });

        if (status === undefined || CLOSED.has(status)) {
          if (taken.fresh) await removeLease(leaser.call, taken.lease, "release");
          lines.push(refuse(id, `${id} is ${status ?? "gone"}`));
          continue;
        }

        lines.push({ id, line: `pinned ${id} until ${leaseTime(held.expires)}`, ok: true });
      } catch (error) {
        lines.push(refuse(id, offline(error) ? "hub offline" : refusalOf(error)));
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
    const failed = (error: unknown) => ({
      ok: false as const,
      reason: offline(error) ? "hub offline" : refusalOf(error),
    });

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

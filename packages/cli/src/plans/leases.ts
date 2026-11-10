import {
  foldLeases,
  LEASE,
  LEASE_CONFLICT,
  LEASE_RELEASED,
  leaseLine,
  leaseMarks,
  leasePlan,
  leaseState,
  type IndexRow,
  type LeaseConflict,
  type LeaseHeld,
  type LeaseReleased,
  type PlanLeases,
} from "skills-core";
import { plansDir } from "./index-tsv.ts";
import { readStore } from "./projection.ts";
import { appendEvent, leaseEvents, type Store } from "./store.ts";
import { syncMeta } from "./sync.ts";

export function leasesIn(store: Store, project?: string): Map<string, PlanLeases> {
  return foldLeases(leaseEvents(store, project));
}

export function enrolledDevice(store: Store): string | undefined {
  const meta = syncMeta(store);
  return meta.checkpoint === undefined ? undefined : meta.device;
}

export function recordHeld(
  store: Store,
  at: number,
  project: string,
  plan: string,
  held: LeaseHeld,
): void {
  appendEvent(store, { kind: "stored", type: LEASE, at, project, plan, payload: held });
}

export function recordReleased(
  store: Store,
  at: number,
  project: string,
  plan: string,
  released: LeaseReleased,
): void {
  appendEvent(store, {
    kind: "stored",
    type: LEASE_RELEASED,
    at,
    project,
    plan,
    payload: released,
  });
}

export function recordConflict(
  store: Store,
  at: number,
  project: string,
  plan: string,
  conflict: LeaseConflict,
): void {
  appendEvent(store, {
    kind: "stored",
    type: LEASE_CONFLICT,
    at,
    project,
    plan,
    payload: conflict,
  });
}

export function releaseOwn(
  store: Store,
  at: number,
  project: string,
  ids: readonly string[],
): void {
  const self = enrolledDevice(store);
  if (self === undefined) return;

  const plans = leasesIn(store, project);
  for (const id of ids) {
    const claim = plans.get(leasePlan(project, id))?.claims.get(self);
    if (claim !== undefined)
      recordReleased(store, at, project, id, {
        device: self,
        acquired: claim.acquired,
        by: self,
        mode: "release",
      });
  }
}

type View = { self: string; plans: Map<string, PlanLeases> };

async function readView(project: string, env: NodeJS.ProcessEnv): Promise<View | undefined> {
  const read = await readStore(plansDir(env), (store) => {
    const self = enrolledDevice(store);
    return self === undefined ? undefined : { self, plans: leasesIn(store, project) };
  });

  return read.kind === "read" ? read.value : undefined;
}

export async function readLeaseMarks(
  project: string,
  rows: readonly IndexRow[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<Map<string, string>> {
  const view = await readView(project, env);
  return view === undefined
    ? new Map()
    : leaseMarks(view.plans, project, rows, view.self, Date.now());
}

export async function readLeaseLine(
  project: string,
  id: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const view = await readView(project, env);
  if (view === undefined) return undefined;
  return leaseLine(leaseState(view.plans.get(leasePlan(project, id)), view.self, Date.now()));
}

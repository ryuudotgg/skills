import {
  foldLeases,
  LEASE,
  LEASE_CONFLICT,
  LEASE_RELEASED,
  leaseLine,
  leaseMarks,
  leasePlan,
  leaseState,
  moveRefusal,
  movingMark,
  staleMark,
  type IndexRow,
  type LeaseConflict,
  type LeaseHeld,
  type LeaseReleased,
  type Moved,
  type PlanLeases,
  type Pulses,
} from "skills-core";
import { plansDir } from "./index-tsv.ts";
import { readStore } from "./projection.ts";
import {
  appendEvent,
  leaseEvents,
  newestHeartbeats,
  projectMoves,
  projectPulses,
  projectRows,
  type Store,
} from "./store.ts";
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

type View = {
  self: string;
  plans: Map<string, PlanLeases>;
  pulses: Pulses;
  moves: Map<string, Moved>;
};

async function readView(project: string, env: NodeJS.ProcessEnv): Promise<View | undefined> {
  const read = await readStore(plansDir(env), (store) => {
    const self = enrolledDevice(store);
    return {
      self: self ?? "",
      plans: self === undefined ? new Map() : leasesIn(store, project),
      pulses: projectPulses(store, project),
      moves: projectMoves(store, project),
    };
  });

  return read.kind === "read" ? read.value : undefined;
}

export async function readLeaseMarks(
  project: string,
  rows: readonly IndexRow[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<Map<string, string>> {
  const view = await readView(project, env);
  if (view === undefined) return new Map();

  const marks = leaseMarks(view.plans, project, rows, view.self, Date.now(), view.pulses);
  for (const row of rows) {
    const moved = view.moves.get(row.id);
    if (moved !== undefined && row.status === "DOING") marks.set(row.id, movingMark(moved));
  }

  return marks;
}

export async function readStaleMarks(
  project: string,
  rows: readonly IndexRow[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<Map<string, string>> {
  const view = await readView(project, env);
  if (view === undefined) return new Map();

  const now = Date.now();
  return new Map(
    rows.flatMap((row) => {
      const state = leaseState(view.plans.get(leasePlan(project, row.id)), view.self, now);
      const mark = staleMark(row, state, view.pulses, now);
      return mark === undefined ? [] : [[row.id, mark] as const];
    }),
  );
}

export async function readLeaseLine(
  project: string,
  id: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const read = await readStore(plansDir(env), (store) => {
    const self = enrolledDevice(store);
    if (self === undefined) return undefined;

    const state = leaseState(
      leasesIn(store, project).get(leasePlan(project, id)),
      self,
      Date.now(),
    );

    return leaseLine(state, newestHeartbeats(store, project).get(id)?.at);
  });

  return read.kind === "read" ? read.value : undefined;
}

export async function readMoveRefusal(
  project: string,
  id: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const read = await readStore(plansDir(env), (store) => {
    const moved = projectMoves(store, project).get(id);
    const row = projectRows(store, project).find((entry) => entry.id === id);
    return moved && row?.status === "DOING"
      ? moveRefusal(id, moved, enrolledDevice(store))
      : undefined;
  });

  return read.kind === "read" ? read.value : undefined;
}

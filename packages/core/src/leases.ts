import type { PlanEvent } from "./events.ts";
import { staleMark, type Pulses } from "./pulse.ts";

export const LEASE = "lease";
export const LEASE_RELEASED = "lease-released";
export const LEASE_CONFLICT = "lease-conflict";

export type LeaseHeld = {
  device: string;
  label: string;
  acquired: string;
  expires: string;
  pinned: boolean;
  provisional: boolean;
  operation: string | null;
};

export type ReleaseMode = "release" | "break";

export type LeaseReleased = {
  device: string;
  acquired: string;
  by: string;
  mode: ReleaseMode;
  moving?: string;
};

export type LeaseConflict = {
  device: string;
  acquired: string;
  holder: string;
  holderAcquired: string;
  holderLabel: string;
};

export type Party = { device: string; label: string };

export type Against = Party & { acquired: string };

export type Claim = LeaseHeld & { conflict: Against | null };

export type PlanLeases = {
  readonly claims: Map<string, Claim>;
  readonly released: Map<string, string>;
  readonly ended: Set<string>;
};

export type LeaseState =
  | { kind: "none" }
  | { kind: "conflict"; other: Party }
  | { kind: "held"; claim: Claim; mine: boolean };

export function leasePlan(project: string, plan: string): string {
  return `${project}/${plan}`;
}

function fields(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function texts(...values: unknown[]): boolean {
  return values.every((value) => typeof value === "string" && value !== "");
}

export function heldFrom(payload: unknown): LeaseHeld | undefined {
  const { device, label, acquired, expires, pinned, provisional, operation } = fields(payload);
  if (!texts(device, label, acquired, expires)) return undefined;
  if (typeof pinned !== "boolean" || typeof provisional !== "boolean") return undefined;
  if (operation !== null && typeof operation !== "string") return undefined;

  return {
    device: device as string,
    label: label as string,
    acquired: acquired as string,
    expires: expires as string,
    pinned,
    provisional,
    operation,
  };
}

export function releasedFrom(payload: unknown): LeaseReleased | undefined {
  const { device, acquired, by, mode, moving } = fields(payload);
  if (!texts(device, acquired, by) || (mode !== "release" && mode !== "break")) return undefined;

  const released: LeaseReleased = {
    device: device as string,
    acquired: acquired as string,
    by: by as string,
    mode,
  };

  return texts(moving) ? { ...released, moving: moving as string } : released;
}

export function conflictFrom(payload: unknown): LeaseConflict | undefined {
  const { device, acquired, holder, holderAcquired, holderLabel } = fields(payload);
  if (!texts(device, acquired, holder, holderAcquired, holderLabel)) return undefined;

  return {
    device: device as string,
    acquired: acquired as string,
    holder: holder as string,
    holderAcquired: holderAcquired as string,
    holderLabel: holderLabel as string,
  };
}

function endOf(device: string, acquired: string): string {
  return `${device} ${acquired}`;
}

function forget(leases: PlanLeases, gone: string): void {
  if (leases.claims.has(gone)) return;

  for (const [device, claim] of leases.claims)
    if (claim.conflict?.device === gone) leases.claims.set(device, { ...claim, conflict: null });
}

function hold(leases: PlanLeases, held: LeaseHeld): void {
  if (leases.ended.has(endOf(held.device, held.acquired))) return;

  const others = [...leases.claims.values()].filter(
    (claim) => claim.device !== held.device && !claim.provisional,
  );

  if (!held.provisional && others.some((claim) => claim.acquired > held.acquired)) return;

  if (!held.provisional)
    for (const { device } of others) {
      leases.claims.delete(device);
      forget(leases, device);
    }

  leases.claims.set(held.device, { ...held, conflict: null });
}

function release(leases: PlanLeases, released: LeaseReleased): void {
  leases.ended.add(endOf(released.device, released.acquired));
  leases.released.set(released.device, released.acquired);

  if (leases.claims.get(released.device)?.acquired === released.acquired)
    leases.claims.delete(released.device);

  forget(leases, released.device);
}

function refuse(leases: PlanLeases, conflict: LeaseConflict): void {
  const claim = leases.claims.get(conflict.device);
  if (claim?.acquired !== conflict.acquired) return;

  const ended = leases.ended.has(endOf(conflict.holder, conflict.holderAcquired));
  const against = {
    device: conflict.holder,
    label: conflict.holderLabel,
    acquired: conflict.holderAcquired,
  };

  leases.claims.set(conflict.device, {
    ...claim,
    operation: null,
    conflict: ended ? claim.conflict : against,
  });
}

export function foldLeases(events: Iterable<PlanEvent>): Map<string, PlanLeases> {
  const plans = new Map<string, PlanLeases>();
  const leasesOf = (event: PlanEvent): PlanLeases => {
    const name = leasePlan(event.project, event.plan);
    const known = plans.get(name);
    if (known !== undefined) return known;

    const made = {
      claims: new Map<string, Claim>(),
      released: new Map<string, string>(),
      ended: new Set<string>(),
    };

    plans.set(name, made);
    return made;
  };

  for (const event of events) {
    if (event.kind !== "stored") continue;

    if (event.type === LEASE) {
      const held = heldFrom(event.payload);
      if (held !== undefined) hold(leasesOf(event), held);
    } else if (event.type === LEASE_RELEASED) {
      const released = releasedFrom(event.payload);
      if (released !== undefined) release(leasesOf(event), released);
    } else if (event.type === LEASE_CONFLICT) {
      const conflict = conflictFrom(event.payload);
      if (conflict !== undefined) refuse(leasesOf(event), conflict);
    }
  }

  return plans;
}

export function pinLive(claim: Claim, now: number): boolean {
  return claim.pinned && Date.parse(claim.expires) > now;
}

export function leaseState(leases: PlanLeases | undefined, self: string, now: number): LeaseState {
  const current = [...(leases?.claims.values() ?? [])].filter(
    (claim) => !claim.pinned || pinLive(claim, now),
  );

  const conflicted = current.find((claim) => claim.conflict !== null);
  if (conflicted?.conflict) {
    const own = { device: conflicted.device, label: conflicted.label };
    const { device, label } = conflicted.conflict;
    return { kind: "conflict", other: own.device === self ? { device, label } : own };
  }

  const claim = current.find((entry) => !entry.provisional) ?? current[0];
  return claim === undefined
    ? { kind: "none" }
    : { kind: "held", claim, mine: claim.device === self };
}

export function leaseTime(iso: string): string {
  return iso.replace(/\.\d+Z$/, "Z");
}

export function leaseMark(state: LeaseState, status: string): string | undefined {
  if (state.kind === "conflict") return `conflict with ${state.other.label}`;
  if (state.kind === "none" || state.mine) return undefined;

  const { label, pinned } = state.claim;
  if (status === "DOING") return `on ${label}`;
  return status === "TODO" && pinned ? `pinned by ${label}` : undefined;
}

export function leaseLine(state: LeaseState, heartbeat?: number): string {
  if (state.kind === "none") return "none";
  if (state.kind === "conflict") return `conflict with ${state.other.label}`;

  const { label, acquired, expires, pinned, provisional } = state.claim;
  return [
    `held by ${label} since ${leaseTime(acquired)}`,
    ...(pinned ? [`pinned until ${leaseTime(expires)}`] : []),
    ...(provisional ? ["provisional"] : []),
    ...(heartbeat === undefined
      ? []
      : [`heartbeat ${leaseTime(new Date(heartbeat).toISOString())}`]),
  ].join(", ");
}

export function leaseMarks(
  plans: ReadonlyMap<string, PlanLeases>,
  project: string,
  rows: readonly { id: string; status: string }[],
  self: string,
  now: number,
  pulses?: Pulses,
): Map<string, string> {
  const marks = new Map<string, string>();
  for (const row of rows) {
    const state = leaseState(plans.get(leasePlan(project, row.id)), self, now);
    const lease = leaseMark(state, row.status);
    const stale = pulses && staleMark(row, state, pulses, now);
    const mark =
      stale === undefined ? lease : state.kind === "conflict" ? `${lease} ${stale}` : stale;

    if (mark !== undefined) marks.set(row.id, mark);
  }

  return marks;
}

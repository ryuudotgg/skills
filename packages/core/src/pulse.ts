import type { LeaseState } from "./leases.ts";
import { machineLabel } from "./machine.ts";

export const HEARTBEAT = "heartbeat";

export const HEARTBEAT_EVERY_MS = 5 * 60_000;

export const STALE_AFTER_MS = 30 * 60_000;

export type Heartbeat = { branch: string; environment: string | null; session?: string };

export type Pulse = { at: number; machine: string };

export type Pulses = {
  readonly newest: ReadonlyMap<string, Pulse>;
  readonly labels: ReadonlyMap<string, string>;
};

export function staleMinutes(pulse: Pulse | undefined, now: number): number | undefined {
  if (pulse === undefined || now - pulse.at <= STALE_AFTER_MS) return undefined;
  return Math.floor((now - pulse.at) / 60_000);
}

export function staleMark(
  row: { id: string; status: string },
  lease: LeaseState,
  pulses: Pulses,
  now: number,
): string | undefined {
  if (row.status !== "DOING") return undefined;

  const pulse = pulses.newest.get(row.id);
  const minutes = staleMinutes(pulse, now);
  if (pulse === undefined || minutes === undefined) return undefined;

  const label =
    lease.kind === "held" ? lease.claim.label : machineLabel(pulses.labels, pulse.machine);

  return `(${label}, stale ${minutes} min)`;
}

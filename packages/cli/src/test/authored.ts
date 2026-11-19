import { sha256 } from "../plans/store.ts";
import {
  authoredHash,
  FIRST_PREVIOUS,
  type AuthoredEvent,
  type Cutoff,
  type RemoteRecord,
  type Verifier,
} from "../plans/sync.ts";

function message(id: string, sequence: number, previous: string, envelope: Uint8Array) {
  return `${id}\n${sequence}\n${previous}\n${sha256(envelope)}`;
}

export function deviceOf(machine: string): string {
  return machine.replaceAll("-", "");
}

export function sign(
  record: RemoteRecord,
  sequence: number,
  previous: string | null,
  id = record.id,
): AuthoredEvent {
  const link = previous ?? FIRST_PREVIOUS;
  const envelope = new TextEncoder().encode(JSON.stringify(record));
  const signature = Buffer.from(sha256(message(id, sequence, link, envelope)), "hex");
  return { id, author: deviceOf(record.machine), sequence, previous: link, signature, envelope };
}

export const trusting: Verifier = {
  async open(event) {
    const expected = sha256(message(event.id, event.sequence, event.previous, event.envelope));
    if (Buffer.from(event.signature).toString("hex") !== expected) return undefined;
    return JSON.parse(new TextDecoder().decode(event.envelope)) as RemoteRecord;
  },
  cutoff: () => undefined,
};

export function trailRecord(
  machine: string,
  wall: number,
  counter: number,
  plan: string,
): RemoteRecord {
  const ts = new Date(wall).toISOString().replace(/\.\d{3}Z$/, "Z");
  const line = ["Skills", plan, "start", `feat/${plan}`].join("\t");
  return {
    id: Bun.randomUUIDv7("hex", wall),
    machine,
    wall,
    counter,
    ts,
    project: "Skills",
    plan,
    type: "start",
    legacy: false,
    payload: { detail: `feat/${plan}`, line: `${ts}\t${line}` },
  };
}

export function chainOf(records: readonly RemoteRecord[]): AuthoredEvent[] {
  const events: AuthoredEvent[] = [];

  let previous: string | null = null;
  for (const [index, record] of records.entries()) {
    const event = sign(record, index + 1, previous);
    events.push(event);
    previous = authoredHash(event);
  }

  return events;
}

export function chained(machine: string, plans: readonly string[]): AuthoredEvent[] {
  return chainOf(plans.map((plan, index) => trailRecord(machine, Date.now() + index, 0, plan)));
}

export function revoking(machine: string, cutoff: Cutoff): Verifier {
  return { ...trusting, cutoff: (author) => (author === deviceOf(machine) ? cutoff : undefined) };
}

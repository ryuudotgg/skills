import {
  envelopeEpoch,
  fromHex,
  hex,
  open,
  subkey,
  verifyEvent,
  CryptoRefusal,
  type AuthoredEvent as CoreEvent,
  type EpochKey,
  type Id,
  type Subkey,
} from "skills-core";
import type { Refused, Skipped } from "../plans/files.ts";
import type { Conflicted, Landed } from "../plans/landing.ts";
import type { AuthoredEvent, RemoteRecord, Verifier } from "../plans/sync.ts";
import { Offline } from "./network.ts";
import { EnrollRefusal, type Deps, type Enrolled } from "./enroll.ts";
import type { LeaseConflictLine } from "./leases.ts";

export const BATCH = 500;

export const HAVE = 1_000;

const WIDE = 8;

export const BYTES_BATCH = 64;

export type SyncReport = {
  pushedEvents: number;
  pushedBlobs: number;
  pulledEvents: number;
  pulledBlobs: number;
  landed: Landed[];
  conflicts: Conflicted[];
  leaseConflicts: LeaseConflictLine[];
  reconciled: boolean;
  refused: number;
  skipped: Skipped[];
  refusedPaths: Refused[];
};

export class Budget {
  readonly deadline: number;

  constructor(ms: number) {
    this.deadline = Date.now() + ms;
  }

  check(): void {
    if (Date.now() > this.deadline)
      throw new Offline("the sync ran out of its time budget, run it again to continue");
  }
}

export function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

export function bytes(value: unknown): Uint8Array {
  if (typeof value !== "string") throw new Offline("the hub sent bytes that are not base64");
  return new Uint8Array(Buffer.from(value, "base64"));
}

export type Pulled = AuthoredEvent & { hub_seq: number };

export function pulledOf(value: unknown): Pulled {
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

export function listOf(body: Record<string, unknown>, key: string): unknown[] {
  const value = body[key];
  if (!Array.isArray(value)) throw new Offline(`the hub sent no ${key} list`);
  return value;
}

export async function wide<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
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

export function chunks<T>(items: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );
}

export class Keys {
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

export type Run = {
  readonly deps: Deps;
  readonly root: string;
  readonly budget: Budget;
  keys: Keys;
  current: Enrolled;
  readonly report: SyncReport;
};

export async function call(
  run: Run,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  run.budget.check();
  return run.current.client.call(method, path, body, run.current.signer);
}

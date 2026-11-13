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
import { HubRefusal } from "./client.ts";
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
  deletedBlobs: number;
  heldBlobs: Set<string>;
  pulledEvents: number;
  pulledBlobs: number;
  landed: Landed[];
  conflicts: Conflicted[];
  leaseConflicts: LeaseConflictLine[];
  reconciled: boolean;
  refused: number;
  skipped: Skipped[];
  refusedPaths: Refused[];
  partial: boolean;
  left: Left;
  stuck?: Stuck;
};

export type Stuck = {
  readonly kind: "blob" | "chunk" | "event";
  readonly id: string;
  readonly size: number;
};

export type Left = { events: number; blobs: number; uncut: number };

export const GRACE = 1_500;

const SMALL_BODY = 16 * 1024;

export const SAMPLE_BODY = 64 * 1024;

export class Spent extends Offline {
  constructor() {
    super("the sync ran out of its time budget, run it again to continue");
  }
}

export type Request = { readonly bytes: number; readonly method: string };

type Samples = { moved: number; moving: number };

function rateOf(samples: Samples): number | undefined {
  return samples.moving > 0 && samples.moved > 0 ? samples.moved / samples.moving : undefined;
}

export class Budget {
  readonly deadline: number;
  readonly hard: number;
  spent = false;

  readonly #saved: number | undefined;
  #slack: number;
  #overrun = 0;
  readonly #puts: Samples = { moved: 0, moving: 0 };
  readonly #posts: Samples = { moved: 0, moving: 0 };
  #latency = 0;
  #floor = Number.POSITIVE_INFINITY;
  #inFlight = 0;
  #active = 0;
  #burst = { began: 0, bytes: 0 };
  #waiting: (() => void)[] = [];

  constructor(ms: number, saved?: { rate: number; slack: number }, grace = 0) {
    this.deadline = Date.now() + ms;
    this.hard = this.deadline + grace;
    this.#saved = saved?.rate;
    this.#slack = Math.min(saved?.slack ?? 0, ms / 4);
  }

  get overrun(): number {
    return this.#overrun;
  }

  get measured(): number | undefined {
    return rateOf(this.#puts) ?? rateOf(this.#posts);
  }

  get bandwidth(): number | undefined {
    return this.measured ?? this.#saved;
  }

  get roundTrip(): number {
    return this.#latency;
  }

  estimate(bytes: number, ahead = this.#inFlight): number {
    const bandwidth = this.bandwidth;
    const transfer = bandwidth === undefined ? 0 : (ahead + bytes) / bandwidth;
    return this.#latency + transfer;
  }

  fits(bytes: number, ahead = this.#inFlight): boolean {
    return Date.now() + this.estimate(bytes, ahead) + this.#slack <= this.deadline;
  }

  check(bytes = 0): void {
    if (this.fits(bytes)) return;
    this.spent = true;
    throw new Spent();
  }

  pushable(from = Date.now()): number | undefined {
    const bandwidth = this.bandwidth;
    if (bandwidth === undefined) return undefined;

    const left = this.deadline - from - 3 * this.#latency - this.#slack;
    return Math.max(0, left * bandwidth - this.#inFlight);
  }

  async timed<T>(request: Request, work: () => Promise<T>): Promise<T> {
    const { bytes, method } = request;
    while (this.#inFlight > 0 && !this.fits(bytes) && this.fits(bytes, 0))
      await new Promise<void>((resolve) => this.#waiting.push(resolve));

    this.check(bytes);

    const began = Date.now();
    const expected = this.estimate(bytes);
    const modeled = this.bandwidth !== undefined;

    const put = method === "PUT";
    const sampled = method !== "GET" && bytes >= SAMPLE_BODY;
    this.#inFlight += bytes;
    if (sampled && put) this.#enter(began, bytes);

    let sent = false;
    let overran = false;
    try {
      const answer = await work();
      sent = true;
      return answer;
    } catch (error) {
      sent = error instanceof HubRefusal;
      overran = !sent && Date.now() >= this.deadline;
      throw error;
    } finally {
      const now = Date.now();
      const took = now - began;
      this.#inFlight -= bytes;
      for (const resolve of this.#waiting.splice(0)) resolve();

      if (sent && (modeled || bytes <= SMALL_BODY)) {
        this.#overrun = Math.max(this.#overrun, took - expected);
        this.#slack = Math.max(this.#slack, this.#overrun);
      }

      const counted = sent || overran;
      if (sampled && put) this.#leave(now, counted ? 0 : bytes);
      else if (sampled && counted) this.#sample(this.#posts, took, bytes);
      else if (overran && bytes > SMALL_BODY) this.#sample(this.#puts, took, bytes);
      else if (method !== "GET" && bytes <= SMALL_BODY) {
        this.#latency = Math.max(this.#latency, took);
        this.#floor = Math.min(this.#floor, took);
      }
    }
  }

  #sample(samples: Samples, took: number, bytes: number): void {
    const floor = Number.isFinite(this.#floor) ? this.#floor : 0;
    samples.moved += bytes;
    samples.moving += Math.max(1, took - floor);
  }

  #enter(now: number, bytes: number): void {
    if (this.#active === 0) this.#burst = { began: now, bytes: 0 };
    this.#active++;
    this.#burst.bytes += bytes;
  }

  #leave(now: number, dropped: number): void {
    this.#active--;
    this.#burst.bytes -= dropped;
    if (this.#active > 0 || this.#burst.bytes <= 0) return;

    this.#sample(this.#puts, now - this.#burst.began, this.#burst.bytes);
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

export function graver(kept: { error: unknown } | undefined, error: unknown): { error: unknown } {
  if (kept === undefined || (kept.error instanceof Spent && !(error instanceof Spent)))
    return { error };

  return kept;
}

export async function wide<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });

  let next = 0;
  let failed: { error: unknown } | undefined;
  async function lane(): Promise<void> {
    while (failed === undefined && next < items.length) {
      const index = next++;
      try {
        results[index] = await work(items[index] as T);
      } catch (error) {
        failed = graver(failed, error);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(WIDE, items.length) }, lane));
  if (failed !== undefined) throw failed.error;

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
  const bytes = body === undefined ? 0 : JSON.stringify(body).length;
  const request = { bytes, method };
  return run.budget.timed(request, () =>
    run.current.client.call(method, path, body, run.current.signer),
  );
}

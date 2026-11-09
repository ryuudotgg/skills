import { Database } from "bun:sqlite";
import {
  ENVELOPE,
  envelopeEpoch,
  hex,
  normaliseBase32,
  rootFingerprint,
  verifyChain,
  type Bytes,
  type Entry,
  type Id,
  type Membership,
} from "skills-core";
import { Refusal } from "./refusal.ts";
import { KIB, MIB, ok, type Context, type Effect, type Route } from "./route.ts";
import type { Tx } from "./store.ts";
import { base64, count, list, parseBody, queryCount, same, text, toBase64 } from "./wire.ts";

export type Chain =
  | { readonly kind: "empty"; readonly length: 0 }
  | {
      readonly kind: "founded";
      readonly length: number;
      readonly head: Bytes;
      readonly wires: readonly Bytes[];
      readonly membership: Membership;
      readonly retired: readonly Bytes[];
    };

export type Principal =
  | { readonly kind: "member"; readonly device: Id }
  | { readonly kind: "revoked"; readonly device: Id }
  | { readonly kind: "pending"; readonly device: Id; readonly invite: Id }
  | { readonly kind: "recovery" }
  | { readonly kind: "retired-recovery" };

export type Candidate = { readonly principal: Principal; readonly signing: Bytes };

type Head = { readonly length: number; readonly hash: string };

const ENTRIES_MAX = 65536;

export function headOf(tx: Tx): Head {
  const row = tx
    .query<{ position: number; hash: Uint8Array }, []>(
      "SELECT position, hash FROM membership ORDER BY position DESC LIMIT 1",
    )
    .get();

  return row === null ? { length: 0, hash: "" } : { length: row.position + 1, hash: hex(row.hash) };
}

export function sameHead(head: Head, chain: Chain): boolean {
  if (chain.kind === "empty") return head.length === 0;
  return head.length === chain.length && head.hash === hex(chain.head);
}

function recoveryKeys(entries: readonly Entry[]): Bytes[] {
  return entries.flatMap((entry) =>
    entry.change.kind === "founding" || entry.change.kind === "recovery"
      ? [entry.change.recovery.signing]
      : [],
  );
}

function sealedLabels(entries: readonly Entry[]): void {
  for (const entry of entries) {
    const { change } = entry;
    if (change.kind !== "founding" && change.kind !== "device") continue;

    try {
      if (change.device.label.length < ENVELOPE.overhead) throw new RangeError("short label");
      envelopeEpoch(change.device.label);
    } catch {
      throw new Refusal("label-not-sealed", { entry: entry.index });
    }
  }
}

async function founded(wires: readonly Bytes[], membership: Membership): Promise<Chain> {
  const keys = recoveryKeys(membership.entries);
  return {
    kind: "founded",
    length: wires.length,
    head: membership.checkpoint.head,
    wires,
    membership,
    retired: keys.slice(0, -1),
  };
}

export class ChainMemo {
  #chain: Chain = { kind: "empty", length: 0 };
  #loading: { readonly key: string; readonly chain: Promise<Chain> } | undefined;

  async current(db: Database): Promise<Chain> {
    const head = headOf(db);
    if (sameHead(head, this.#chain)) return this.#chain;

    const key = `${head.length}/${head.hash}`;
    if (this.#loading?.key !== key) this.#loading = { key, chain: this.#load(db) };

    return this.#loading.chain;
  }

  async #load(db: Database): Promise<Chain> {
    const wires = db
      .query<{ entry: Uint8Array }, []>("SELECT entry FROM membership ORDER BY position")
      .all()
      .map((row) => new Uint8Array(row.entry));

    const chain = await verified(wires);
    if (sameHead(headOf(db), chain)) this.#chain = chain;

    return chain;
  }

  adopt(chain: Chain): void {
    this.#chain = chain;
  }
}

async function verified(wires: readonly Bytes[]): Promise<Chain> {
  const first = wires[0];
  if (first === undefined) return { kind: "empty", length: 0 };

  const membership = await verifyChain(wires, { fingerprint: await rootFingerprint(first) });
  return founded(wires, membership);
}

export function identify(tx: Tx, chain: Chain, device: Id | "recovery"): Candidate | undefined {
  if (chain.kind === "empty") return undefined;
  if (device === "recovery")
    return { principal: { kind: "recovery" }, signing: chain.membership.recovery.signing };

  const known = chain.membership.devices.get(device);
  if (known !== undefined)
    return {
      principal:
        known.revoked === undefined ? { kind: "member", device } : { kind: "revoked", device },
      signing: known.signing,
    };

  const pending = tx
    .query<{ invite: string; signing: Uint8Array }, { device: string }>(
      "SELECT invite, signing FROM pending WHERE device = $device",
    )
    .get({ device });

  if (pending === null) return undefined;

  return {
    principal: { kind: "pending", device, invite: pending.invite as Id },
    signing: new Uint8Array(pending.signing),
  };
}

export type Extension = { readonly chain: Chain; readonly fresh: readonly Entry[] };

export async function extendChain(
  chain: Chain,
  from: number,
  wires: readonly Bytes[],
): Promise<Extension> {
  if (from > chain.length) throw new Refusal("chain-moved", { length: chain.length });

  const stored = chain.kind === "founded" ? chain.wires : [];
  const overlap = Math.min(stored.length - from, wires.length);
  for (let index = 0; index < overlap; index++)
    if (!same(stored[from + index] ?? new Uint8Array(), wires[index] ?? new Uint8Array()))
      throw new Refusal("chain-fork", { entry: from + index });

  const added = wires.slice(overlap);
  if (added.length === 0) return { chain, fresh: [] };

  const all = [...stored, ...added];
  const next =
    chain.kind === "founded"
      ? await founded(all, await verifyChain(all, chain.membership.checkpoint))
      : await verified(all);

  const fresh = next.kind === "founded" ? next.membership.entries.slice(stored.length) : [];
  sealedLabels(fresh);

  return { chain: next, fresh };
}

export function appendEntries(tx: Tx, extension: Extension): void {
  if (extension.chain.kind !== "founded") return;

  const insert = tx.query<never, { position: number; hash: Uint8Array; entry: Uint8Array }>(
    "INSERT INTO membership (position, hash, entry) VALUES ($position, $hash, $entry)",
  );

  for (const entry of extension.fresh) {
    const wire = extension.chain.wires[entry.index];
    if (wire === undefined) throw new TypeError("an appended entry has no wire");
    insert.run({ position: entry.index, hash: entry.hash, entry: wire });
  }
}

function headAnswer(chain: Chain) {
  return chain.kind === "founded"
    ? { length: chain.length, head: hex(chain.head) }
    : { length: 0, head: null };
}

function entryWires(value: readonly unknown[]): Bytes[] {
  return value.map((wire, index) => base64(wire, `entries.${index}`));
}

function sameCode(given: string, expected: string): boolean {
  const left = new TextEncoder().encode(normaliseBase32(given));
  const right = new TextEncoder().encode(expected);
  if (left.length !== right.length) return false;

  let difference = 0;
  for (let index = 0; index < left.length; index++)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);

  return difference === 0;
}

async function foundVault(context: Context): Promise<Effect> {
  const body = parseBody(context.body, ["code", "entries"]);
  const code = text(body, "code");
  const { initCode } = context.hub;
  if (context.chain.kind === "founded" || initCode === undefined) throw new Refusal("vault-exists");
  if (!sameCode(code, initCode)) throw new Refusal("init-code");

  const wires = entryWires(list(body, "entries", ENTRIES_MAX));
  if (wires.length === 0) throw new Refusal("malformed", { field: "entries" });

  const extension = await extendChain(context.chain, 0, wires);
  return (tx) => {
    appendEntries(tx, extension);
    return { status: 201, body: headAnswer(extension.chain), chain: extension.chain };
  };
}

async function readMembership(context: Context): Promise<Effect> {
  const after = queryCount(context.query.get("after"), 0, "after");
  const { chain } = context;
  const wires = chain.kind === "founded" ? chain.wires.slice(after) : [];
  return ok({ ...headAnswer(chain), entries: wires.map(toBase64) });
}

async function extendMembership(context: Context): Promise<Effect> {
  const body = parseBody(context.body, ["from", "entries"]);
  if (context.chain.kind === "empty") throw new Refusal("no-vault");

  const from = count(body.from, "from");
  const extension = await extendChain(
    context.chain,
    from,
    entryWires(list(body, "entries", ENTRIES_MAX)),
  );

  return (tx) => {
    appendEntries(tx, extension);
    return { status: 200, body: headAnswer(extension.chain), chain: extension.chain };
  };
}

async function readRecovery(context: Context): Promise<Effect> {
  const { chain } = context;
  if (chain.kind === "empty") throw new Refusal("no-vault");

  const wraps = (chain.membership.wraps.get("recovery") ?? []).map((wrap) => ({
    ephemeral: toBase64(wrap.ephemeral),
    envelope: toBase64(wrap.envelope),
  }));

  return ok({ ...headAnswer(chain), entries: chain.wires.map(toBase64), wraps });
}

async function recoverDevice(context: Context): Promise<Effect> {
  const body = parseBody(context.body, ["entry"]);
  const { chain } = context;
  if (chain.kind === "empty") throw new Refusal("no-vault");

  const wire = base64(body.entry, "entry");
  if (chain.wires.some((stored) => same(stored, wire))) return ok(headAnswer(chain), 201);

  const extension = await extendChain(chain, chain.length, [wire]);
  const [entry] = extension.fresh;
  if (
    extension.fresh.length !== 1 ||
    entry?.change.kind !== "device" ||
    entry.signer.kind !== "recovery"
  )
    throw new Refusal("entry-rule", { entry: chain.length });

  return (tx) => {
    appendEntries(tx, extension);
    return { status: 201, body: headAnswer(extension.chain), chain: extension.chain };
  };
}

export const chainRoutes: readonly Route[] = [
  {
    method: "POST",
    pattern: "/v1/vault",
    access: { kind: "unsigned" },
    limit: 32 * MIB,
    prepare: foundVault,
  },
  {
    method: "GET",
    pattern: "/v1/membership",
    access: { kind: "signed", callers: ["member"] },
    limit: 0,
    prepare: readMembership,
  },
  {
    method: "POST",
    pattern: "/v1/membership",
    access: { kind: "signed", callers: ["member"] },
    limit: 32 * MIB,
    prepare: extendMembership,
  },
  {
    method: "GET",
    pattern: "/v1/recover",
    access: { kind: "signed", callers: ["recovery"] },
    limit: 0,
    prepare: readRecovery,
  },
  {
    method: "POST",
    pattern: "/v1/recover",
    access: { kind: "signed", callers: ["recovery"] },
    limit: 256 * KIB,
    prepare: recoverDevice,
  },
];

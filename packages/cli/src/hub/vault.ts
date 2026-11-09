import {
  ENVELOPE,
  LAYOUT,
  envelopeEpoch,
  fromHex,
  hex,
  open,
  parseId,
  seal,
  subkey,
  unwrapBundle,
  verifyChain,
  type Bytes,
  type Checkpoint,
  type EpochKey,
  type Id,
  type Member,
  type Membership,
  type Recipient,
  type WrappingKeys,
} from "skills-core";
import { write, type Store } from "../plans/store.ts";
import { setSyncMeta, syncMeta } from "../plans/sync.ts";

export type Local = {
  readonly device: Id | undefined;
  readonly wires: readonly Bytes[];
  readonly checkpoint: Checkpoint | undefined;
};

export type PendingJoin = { readonly invite: Id; readonly device: Id; readonly nonce: Id };

export type Outgoing = { readonly from: number; readonly wire: Bytes };

export type StoredInvite = {
  readonly id: Id;
  readonly secret: Bytes;
  readonly label: string;
  readonly expires: number;
  readonly text: string | undefined;
};

export type EpochRange = { readonly first: number; readonly last: number };

const PENDING = "pending";

const OUTGOING = "outgoing";

function inviteKey(id: string): string {
  return `invite:${id}`;
}

const BUNDLE_KEY = 2 + LAYOUT.key;

export class ForkDetected extends Error {
  override name = "ForkDetected";

  constructor() {
    super("fork detected");
  }
}

function checkpointOf(stored: NonNullable<ReturnType<typeof syncMeta>["checkpoint"]>): Checkpoint {
  return {
    fingerprint: fromHex(stored.fingerprint),
    head: fromHex(stored.head),
    length: stored.length,
    epoch: stored.epoch,
  };
}

export function readLocal(store: Store): Local {
  const meta = syncMeta(store);
  const rows = store.db
    .query("SELECT entry, signature FROM membership ORDER BY position")
    .all() as { entry: Uint8Array; signature: Uint8Array }[];

  const wires = rows.map((row) => {
    const wire = new Uint8Array(row.entry.length + row.signature.length);
    wire.set(row.entry);
    wire.set(row.signature, row.entry.length);
    return wire;
  });

  return {
    device: meta.device === undefined ? undefined : parseId(meta.device),
    wires,
    checkpoint: meta.checkpoint === undefined ? undefined : checkpointOf(meta.checkpoint),
  };
}

export async function verifiedLocal(local: Local): Promise<Membership | undefined> {
  if (local.checkpoint === undefined) return undefined;
  if (local.wires.length !== local.checkpoint.length) throw new ForkDetected();
  return verifyChain(local.wires, local.checkpoint);
}

export function setDevice(store: Store, device: Id): void {
  write(store, () => setSyncMeta(store, { device, sequence: 0, pushed: 0 }));
}

export function adopt(store: Store, wires: readonly Bytes[], membership: Membership): void {
  write(store, () => {
    const stored = readLocal(store);
    const shared = Math.min(stored.wires.length, wires.length);
    for (let index = 0; index < shared; index++)
      if (hex(stored.wires[index] ?? new Uint8Array()) !== hex(wires[index] ?? new Uint8Array()))
        throw new ForkDetected();

    if (stored.wires.length >= wires.length) return;

    for (const entry of membership.entries.slice(stored.wires.length)) {
      const wire = wires[entry.index] ?? new Uint8Array();
      store.db.run(
        "INSERT INTO membership (position, hash, entry, signature) VALUES (?, ?, ?, ?)",
        [
          entry.index,
          hex(entry.hash),
          wire.slice(0, -LAYOUT.signature),
          wire.slice(-LAYOUT.signature),
        ],
      );
    }

    const { checkpoint } = membership;
    setSyncMeta(store, {
      checkpoint: {
        fingerprint: hex(checkpoint.fingerprint),
        head: hex(checkpoint.head),
        length: checkpoint.length,
        epoch: checkpoint.epoch,
      },
    });

    for (const invite of membership.invitesUsed) deleteInvite(store, invite);
  });
}

function metaText(store: Store, key: string): string | undefined {
  const row = store.db.query("SELECT value FROM meta WHERE key = ?").get(key) as {
    value: string;
  } | null;

  return row?.value;
}

function setMeta(store: Store, key: string, value: string | undefined): void {
  if (value === undefined) store.db.run("DELETE FROM meta WHERE key = ?", [key]);
  else
    store.db.run(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [key, value],
    );
}

export function readPending(store: Store): PendingJoin | undefined {
  const value = metaText(store, PENDING);
  return value === undefined ? undefined : (JSON.parse(value) as PendingJoin);
}

export function setPending(store: Store, pending: PendingJoin | undefined): void {
  write(store, () => setMeta(store, PENDING, pending && JSON.stringify(pending)));
}

export function readOutgoing(store: Store): Outgoing | undefined {
  const value = metaText(store, OUTGOING);
  if (value === undefined) return undefined;

  const { from, wire } = JSON.parse(value) as { from: number; wire: string };
  return { from, wire: fromHex(wire) };
}

export function setOutgoing(store: Store, outgoing: Outgoing | undefined): void {
  const value = outgoing && JSON.stringify({ from: outgoing.from, wire: hex(outgoing.wire) });
  write(store, () => setMeta(store, OUTGOING, value));
}

export function liveInvites(store: Store, now: number): StoredInvite[] {
  const rows = store.db
    .query("SELECT id, secret, label, expires FROM invites WHERE expires >= ? ORDER BY expires")
    .all(now) as { id: string; secret: Uint8Array; label: string | null; expires: number }[];

  return rows.map((row) => ({
    id: parseId(row.id),
    secret: new Uint8Array(row.secret),
    label: row.label ?? "",
    expires: row.expires,
    text: metaText(store, inviteKey(row.id)),
  }));
}

function deleteInvite(store: Store, id: string): void {
  store.db.run("DELETE FROM invites WHERE id = ?", [id]);
  setMeta(store, inviteKey(id), undefined);
}

export function saveInvite(store: Store, invite: StoredInvite, now: number): void {
  write(store, () => {
    const expired = store.db.query("SELECT id FROM invites WHERE expires < ?").all(now) as {
      id: string;
    }[];

    for (const { id } of expired) deleteInvite(store, id);

    store.db.run("INSERT INTO invites (id, secret, label, expires) VALUES (?, ?, ?, ?)", [
      invite.id,
      invite.secret,
      invite.label,
      invite.expires,
    ]);

    setMeta(store, inviteKey(invite.id), invite.text);
  });
}

export function hasInvite(store: Store, id: Id): boolean {
  return store.db.query("SELECT 1 FROM invites WHERE id = ?").get(id) !== null;
}

export function dropInvite(store: Store, id: Id): void {
  write(store, () => deleteInvite(store, id));
}

export async function epochKeys(
  membership: Membership,
  recipient: Recipient,
  wrapping: WrappingKeys,
): Promise<Map<number, EpochKey>> {
  const keys = new Map<number, EpochKey>();
  for (const wrap of membership.wraps.get(recipient) ?? [])
    for (const key of await unwrapBundle(wrapping, wrap)) keys.set(key.epoch, key);

  return keys;
}

export function heldEpochs(keys: ReadonlyMap<number, EpochKey>, through: number): EpochKey[] {
  return Array.from({ length: through }, (_, index) => keys.get(index + 1)).filter(
    (key): key is EpochKey => key !== undefined,
  );
}

export function readable(membership: Membership, recipient: Recipient): EpochRange | undefined {
  const ranges = (membership.wraps.get(recipient) ?? []).map((wrap) => {
    const last = envelopeEpoch(wrap.envelope);
    const count = (wrap.envelope.length - ENVELOPE.overhead - 2) / BUNDLE_KEY;
    return { first: last - count + 1, last };
  });

  if (ranges.length === 0) return undefined;

  return {
    first: Math.min(...ranges.map((range) => range.first)),
    last: Math.max(...ranges.map((range) => range.last)),
  };
}

function labelData(device: Id): string {
  return `label/${device}`;
}

export async function sealLabel(key: EpochKey, device: Id, label: string): Promise<Bytes> {
  return seal(await subkey(key, "labels"), new TextEncoder().encode(label), labelData(device));
}

export async function openLabel(
  keys: ReadonlyMap<number, EpochKey>,
  member: Pick<Member, "id" | "label">,
): Promise<string | undefined> {
  try {
    const key = keys.get(envelopeEpoch(member.label));
    if (key === undefined) return undefined;

    const text = new TextDecoder().decode(
      await open(await subkey(key, "labels"), member.label, labelData(member.id)),
    );

    return text === "" ? undefined : text;
  } catch {
    return undefined;
  }
}

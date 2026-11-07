import { NO_HASH, type AuthorTail } from "./authored.ts";
import {
  Reader,
  concat,
  equal,
  hex,
  idBytes,
  idText,
  sha256,
  systemEntropy,
  u16,
  u32,
  u8,
  type Bytes,
  type Entropy,
  type Id,
} from "./bytes.ts";
import type { Checkpoint } from "./codes.ts";
import { envelopeEpoch, type EpochKey } from "./envelope.ts";
import {
  signAs,
  verifies,
  wrapBundleWith,
  type Recipient,
  type SigningKeys,
  type Wrap,
} from "./keys.ts";
import {
  CryptoRefusal,
  ENTRY_KINDS,
  ENVELOPE,
  LAYOUT,
  SIGNERS,
  checkEpoch,
  refuse,
} from "./protocol.ts";

export type DeviceCard = {
  readonly id: Id;
  readonly signing: Bytes;
  readonly wrapping: Bytes;
  readonly label: Bytes;
};

export type RecoveryCard = { readonly signing: Bytes; readonly wrapping: Bytes };

export type SignerRef =
  | { readonly kind: "device"; readonly id: Id }
  | { readonly kind: "recovery" };

export type Signer =
  | { readonly kind: "device"; readonly id: Id; readonly keys: SigningKeys }
  | { readonly kind: "recovery"; readonly keys: SigningKeys };

export type EntryChange =
  | { kind: "founding"; device: DeviceCard; recovery: RecoveryCard; wraps: readonly Wrap[] }
  | { kind: "device"; device: DeviceCard; invite: Id | null; wrap: Wrap }
  | { kind: "revocation"; revoked: Id; cutoff: AuthorTail; epoch: number; wraps: readonly Wrap[] }
  | { kind: "epoch"; epoch: number; wraps: readonly Wrap[] }
  | { kind: "recovery"; recovery: RecoveryCard; epoch: number; wraps: readonly Wrap[] };

export type Entry = {
  readonly index: number;
  readonly previous: Bytes;
  readonly signer: SignerRef;
  readonly hash: Bytes;
  readonly change: EntryChange;
};

export type Member = {
  readonly id: Id;
  readonly signing: Bytes;
  readonly wrapping: Bytes;
  readonly label: Bytes;
  readonly joined: { readonly entry: number; readonly epoch: number };
  readonly revoked:
    | { readonly entry: number; readonly epoch: number; readonly cutoff: AuthorTail }
    | undefined;
};

export type Membership = {
  readonly checkpoint: Checkpoint;
  readonly devices: ReadonlyMap<Id, Member>;
  readonly recovery: RecoveryCard;
  readonly invitesUsed: ReadonlySet<Id>;
  readonly wraps: ReadonlyMap<Recipient, readonly Wrap[]>;
  readonly entries: readonly Entry[];
};

export type FoundingDraft = {
  kind: "founding";
  device: DeviceCard;
  recovery: RecoveryCard;
  key: EpochKey;
};

export type LaterDraft =
  | { kind: "device"; device: DeviceCard; invite: Id | null; keys: readonly EpochKey[] }
  | { kind: "revocation"; revoked: Id; cutoff: AuthorTail | null; key: EpochKey }
  | { kind: "epoch"; key: EpochKey }
  | { kind: "recovery"; recovery: RecoveryCard; keys: readonly EpochKey[] };

type Decoded = { entry: Entry; unsigned: Bytes; signature: Bytes };

const NO_ID: Bytes = new Uint8Array(LAYOUT.id);

function encodeCard(card: DeviceCard): Bytes {
  return concat(idBytes(card.id), card.signing, card.wrapping, u16(card.label.length), card.label);
}

function encodeRecoveryCard(card: RecoveryCard): Bytes {
  return concat(card.signing, card.wrapping);
}

function recipientOrder(left: Wrap, right: Wrap): number {
  const key = (wrap: Wrap) => (wrap.recipient === "recovery" ? "1" : `0${wrap.recipient}`);
  return key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0;
}

function encodeWrap(wrap: Wrap): Bytes {
  const recipient =
    wrap.recipient === "recovery" ? concat([1], NO_ID) : concat([0], idBytes(wrap.recipient));

  return concat(recipient, wrap.ephemeral, u32(wrap.envelope.length), wrap.envelope);
}

function encodeWraps(wraps: readonly Wrap[]): Bytes {
  return concat(u16(wraps.length), ...[...wraps].sort(recipientOrder).map(encodeWrap));
}

function encodeChange(change: EntryChange): Bytes {
  if (change.kind === "founding")
    return concat(
      encodeCard(change.device),
      encodeRecoveryCard(change.recovery),
      encodeWraps(change.wraps),
    );

  if (change.kind === "device")
    return concat(
      encodeCard(change.device),
      change.invite === null ? [0] : concat([1], idBytes(change.invite)),
      encodeWrap(change.wrap),
    );

  if (change.kind === "revocation")
    return concat(
      idBytes(change.revoked),
      u32(change.cutoff.sequence),
      change.cutoff.hash,
      u16(change.epoch),
      encodeWraps(change.wraps),
    );

  if (change.kind === "epoch") return concat(u16(change.epoch), encodeWraps(change.wraps));

  return concat(encodeRecoveryCard(change.recovery), u16(change.epoch), encodeWraps(change.wraps));
}

function encodeUnsigned(previous: Uint8Array, signer: SignerRef, change: EntryChange): Bytes {
  return concat(
    [LAYOUT.version],
    u8(ENTRY_KINDS.indexOf(change.kind) + 1),
    previous,
    u8(SIGNERS.indexOf(signer.kind)),
    signer.kind === "device" ? idBytes(signer.id) : NO_ID,
    encodeChange(change),
  );
}

function readCard(reader: Reader): DeviceCard {
  const id = idText(reader.take(LAYOUT.id));
  const signing = reader.take(LAYOUT.key);
  const wrapping = reader.take(LAYOUT.key);
  return { id, signing, wrapping, label: reader.take(reader.u16()) };
}

function readRecoveryCard(reader: Reader): RecoveryCard {
  return { signing: reader.take(LAYOUT.key), wrapping: reader.take(LAYOUT.key) };
}

function readWrap(reader: Reader): Wrap {
  const tag = reader.u8();
  const id = reader.take(LAYOUT.id);
  if (tag > 1 || (tag === 1 && !equal(id, NO_ID))) refuse("malformed");

  const recipient = tag === 1 ? "recovery" : idText(id);
  const ephemeral = reader.take(LAYOUT.key);
  return { recipient, ephemeral, envelope: reader.take(reader.u32()) };
}

function readWraps(reader: Reader): Wrap[] {
  const wraps = Array.from({ length: reader.u16() }, () => readWrap(reader));
  if (wraps.some((wrap, index) => index > 0 && recipientOrder(wraps[index - 1] ?? wrap, wrap) >= 0))
    refuse("malformed");

  return wraps;
}

function readCutoff(reader: Reader): AuthorTail {
  const sequence = reader.u32();
  const hash = reader.take(LAYOUT.hash);
  if (sequence === 0 && !equal(hash, NO_HASH)) refuse("malformed");

  return { sequence, hash };
}

function readChange(kind: number, reader: Reader): EntryChange {
  if (kind === 1)
    return {
      kind: "founding",
      device: readCard(reader),
      recovery: readRecoveryCard(reader),
      wraps: readWraps(reader),
    };

  if (kind === 2) {
    const device = readCard(reader);
    const flag = reader.u8();
    if (flag > 1) refuse("malformed");

    const invite = flag === 1 ? idText(reader.take(LAYOUT.id)) : null;
    return { kind: "device", device, invite, wrap: readWrap(reader) };
  }

  if (kind === 3) {
    const revoked = idText(reader.take(LAYOUT.id));
    const cutoff = readCutoff(reader);
    return {
      kind: "revocation",
      revoked,
      cutoff,
      epoch: checkEpoch(reader.u16()),
      wraps: readWraps(reader),
    };
  }

  if (kind === 4)
    return { kind: "epoch", epoch: checkEpoch(reader.u16()), wraps: readWraps(reader) };

  if (kind === 5) {
    const recovery = readRecoveryCard(reader);
    return {
      kind: "recovery",
      recovery,
      epoch: checkEpoch(reader.u16()),
      wraps: readWraps(reader),
    };
  }

  return refuse("malformed");
}

async function decodeEntry(wire: Uint8Array, index: number): Promise<Decoded> {
  try {
    if (wire.length <= LAYOUT.signature) refuse("malformed");

    const unsigned = wire.slice(0, -LAYOUT.signature);
    const reader = new Reader(unsigned);
    if (reader.u8() !== LAYOUT.version) refuse("malformed");

    const kind = reader.u8();
    const previous = reader.take(LAYOUT.hash);
    const tag = reader.u8();
    const signerId = reader.take(LAYOUT.id);
    if (tag > 1 || (tag === 1 && !equal(signerId, NO_ID))) refuse("malformed");

    const signer: SignerRef =
      tag === 0 ? { kind: "device", id: idText(signerId) } : { kind: "recovery" };

    const change = readChange(kind, reader);
    reader.end();

    const entry = { index, previous, signer, hash: await sha256(unsigned), change };
    return {
      entry,
      unsigned: new Uint8Array(unsigned),
      signature: new Uint8Array(wire.slice(-LAYOUT.signature)),
    };
  } catch (error) {
    if (error instanceof CryptoRefusal && error.entry === undefined) refuse(error.reason, index);
    throw error;
  }
}

function wrapEpoch(wrap: Wrap): number {
  try {
    return envelopeEpoch(wrap.envelope);
  } catch {
    return 0;
  }
}

function active(membership: Membership): Member[] {
  return [...membership.devices.values()].filter((member) => member.revoked === undefined);
}

function bundleSize(count: number): number {
  return ENVELOPE.overhead + 2 + count * (2 + LAYOUT.key);
}

function holds(wrap: Wrap, epoch: number, history: boolean): boolean {
  return wrapEpoch(wrap) === epoch && wrap.envelope.length === bundleSize(history ? epoch : 1);
}

function covers(
  wraps: readonly Wrap[],
  recipients: readonly Recipient[],
  epoch: number,
  history: Recipient | null = null,
): boolean {
  const named = new Set<Recipient>(wraps.map((wrap) => wrap.recipient));

  return (
    wraps.length === recipients.length &&
    recipients.every((recipient) => named.has(recipient)) &&
    wraps.every((wrap) => holds(wrap, epoch, wrap.recipient === history))
  );
}

function keysInUse(membership: Membership | undefined): Set<string> {
  const used = new Set<string>();
  for (const entry of membership?.entries ?? []) {
    const { change } = entry;
    if (change.kind === "founding" || change.kind === "device")
      for (const key of [change.device.signing, change.device.wrapping]) used.add(hex(key));

    if (change.kind === "founding" || change.kind === "recovery")
      for (const key of [change.recovery.signing, change.recovery.wrapping]) used.add(hex(key));
  }

  return used;
}

function fresh(used: Set<string>, keys: readonly Bytes[]): boolean {
  const seen = new Set(used);
  for (const key of keys) {
    if (seen.has(hex(key))) return false;
    seen.add(hex(key));
  }

  return true;
}

function signerKey(state: Membership | undefined, decoded: Decoded): Bytes {
  const { entry } = decoded;
  const { change, signer, index } = entry;
  if (state === undefined) {
    if (change.kind !== "founding") return refuse("entry-rule", index);
    if (signer.kind !== "device" || signer.id !== change.device.id)
      return refuse("entry-signer", index);

    return change.device.signing;
  }

  if (change.kind === "founding") return refuse("entry-rule", index);

  if (signer.kind === "recovery") {
    if (change.kind !== "device" || change.invite !== null) return refuse("entry-signer", index);
    return state.recovery.signing;
  }

  const member = state.devices.get(signer.id);
  if (member === undefined || member.revoked !== undefined) return refuse("entry-signer", index);

  return member.signing;
}

function append(
  wraps: ReadonlyMap<Recipient, readonly Wrap[]>,
  added: readonly Wrap[],
  resetRecovery: boolean,
): Map<Recipient, readonly Wrap[]> {
  const next = new Map(wraps);
  if (resetRecovery) next.delete("recovery");

  for (const wrap of added) next.set(wrap.recipient, [...(next.get(wrap.recipient) ?? []), wrap]);

  return next;
}

async function apply(state: Membership | undefined, decoded: Decoded): Promise<Membership> {
  const { entry, unsigned, signature } = decoded;
  const { change, index } = entry;
  if (!equal(entry.previous, state?.checkpoint.head ?? NO_HASH)) refuse("chain-link", index);

  const key = signerKey(state, decoded);
  if (!(await verifies("entry", key, unsigned, signature))) refuse("entry-signature", index);

  const used = keysInUse(state);
  const entries = [...(state?.entries ?? []), entry];
  const checkpointOf = (epoch: number): Checkpoint => ({
    fingerprint: state?.checkpoint.fingerprint ?? entry.hash.slice(0, LAYOUT.fingerprint),
    head: entry.hash,
    length: index + 1,
    epoch,
  });

  if (state === undefined) {
    if (change.kind !== "founding") return refuse("entry-rule", index);

    const keys = [
      change.device.signing,
      change.device.wrapping,
      change.recovery.signing,
      change.recovery.wrapping,
    ];

    if (!fresh(used, keys) || !covers(change.wraps, [change.device.id, "recovery"], 1))
      refuse("entry-rule", index);

    const founder: Member = {
      ...change.device,
      joined: { entry: index, epoch: 1 },
      revoked: undefined,
    };

    return {
      checkpoint: checkpointOf(1),
      devices: new Map([[founder.id, founder]]),
      recovery: change.recovery,
      invitesUsed: new Set(),
      wraps: append(new Map(), change.wraps, false),
      entries,
    };
  }

  const epoch = state.checkpoint.epoch;
  const remaining = active(state);

  if (change.kind === "device") {
    const { device, invite, wrap } = change;
    if (state.devices.has(device.id) || !fresh(used, [device.signing, device.wrapping]))
      refuse("entry-rule", index);

    if (entry.signer.kind === "device" && (invite === null || state.invitesUsed.has(invite)))
      refuse("entry-rule", index);

    if (wrap.recipient !== device.id || !holds(wrap, epoch, true)) refuse("entry-rule", index);

    const member: Member = { ...device, joined: { entry: index, epoch }, revoked: undefined };
    const invitesUsed = new Set(state.invitesUsed);
    if (invite !== null) invitesUsed.add(invite);

    return {
      ...state,
      checkpoint: checkpointOf(epoch),
      devices: new Map(state.devices).set(device.id, member),
      invitesUsed,
      wraps: append(state.wraps, [wrap], false),
      entries,
    };
  }

  if (change.kind === "founding") return refuse("entry-rule", index);
  if (change.epoch !== epoch + 1) refuse("entry-rule", index);

  if (change.kind === "revocation") {
    const target = state.devices.get(change.revoked);
    if (target === undefined || target.revoked !== undefined) return refuse("entry-rule", index);

    const recipients = [
      ...remaining.filter((member) => member.id !== target.id).map((member) => member.id),
      "recovery" as const,
    ];

    if (!covers(change.wraps, recipients, change.epoch)) refuse("entry-rule", index);

    const revoked = { entry: index, epoch: change.epoch, cutoff: change.cutoff };
    return {
      ...state,
      checkpoint: checkpointOf(change.epoch),
      devices: new Map(state.devices).set(target.id, { ...target, revoked }),
      wraps: append(state.wraps, change.wraps, false),
      entries,
    };
  }

  const recipients = [...remaining.map((member) => member.id), "recovery" as const];
  const history = change.kind === "recovery" ? "recovery" : null;
  if (!covers(change.wraps, recipients, change.epoch, history)) refuse("entry-rule", index);

  if (change.kind === "epoch")
    return {
      ...state,
      checkpoint: checkpointOf(change.epoch),
      wraps: append(state.wraps, change.wraps, false),
      entries,
    };

  if (!fresh(used, [change.recovery.signing, change.recovery.wrapping]))
    refuse("entry-rule", index);

  return {
    ...state,
    checkpoint: checkpointOf(change.epoch),
    recovery: change.recovery,
    wraps: append(state.wraps, change.wraps, true),
    entries,
  };
}

export async function rootFingerprint(founding: Uint8Array): Promise<Bytes> {
  if (founding.length <= LAYOUT.signature) refuse("malformed");
  return (await sha256(founding.slice(0, -LAYOUT.signature))).slice(0, LAYOUT.fingerprint);
}

export async function verifyChain(
  entries: readonly Uint8Array[],
  trusted: Checkpoint | { readonly fingerprint: Uint8Array },
): Promise<Membership> {
  const first = entries[0];
  if (first === undefined || !equal(await rootFingerprint(first), trusted.fingerprint))
    refuse("chain-root");

  if ("head" in trusted && (trusted.length < 1 || entries.length < trusted.length))
    refuse("chain-fork");

  let state: Membership | undefined;
  for (const [index, wire] of entries.entries()) {
    state = await apply(state, await decodeEntry(wire, index));
    if ("head" in trusted && index === trusted.length - 1) {
      const { head, epoch } = state.checkpoint;
      if (!equal(head, trusted.head) || epoch !== trusted.epoch) refuse("chain-fork");
    }
  }

  if (state === undefined) return refuse("chain-root");

  return state;
}

async function wrapTo(
  entropy: Entropy,
  recipients: readonly { id: Recipient; wrapping: Uint8Array }[],
  keys: readonly EpochKey[],
): Promise<Wrap[]> {
  const wraps: Wrap[] = [];
  for (const recipient of recipients) wraps.push(await wrapBundleWith(entropy, recipient, keys));
  return wraps;
}

async function changeOf(
  entropy: Entropy,
  draft: FoundingDraft | LaterDraft,
  after: Membership | undefined,
): Promise<EntryChange> {
  if (draft.kind === "founding") {
    const recipients = [
      { id: draft.device.id, wrapping: draft.device.wrapping },
      { id: "recovery" as const, wrapping: draft.recovery.wrapping },
    ];

    const wraps = await wrapTo(entropy, recipients, [draft.key]);
    return { kind: "founding", device: draft.device, recovery: draft.recovery, wraps };
  }

  if (after === undefined) throw new TypeError("a later entry signs after a verified membership");

  const devices = active(after).map((member) => ({ id: member.id, wrapping: member.wrapping }));
  const recovery = { id: "recovery" as const, wrapping: after.recovery.wrapping };

  if (draft.kind === "device") {
    const [wrap] = await wrapTo(
      entropy,
      [{ id: draft.device.id, wrapping: draft.device.wrapping }],
      draft.keys,
    );

    if (wrap === undefined) throw new TypeError("a device entry wraps one bundle");
    return { kind: "device", device: draft.device, invite: draft.invite, wrap };
  }

  if (draft.kind === "revocation") {
    const remaining = devices.filter((device) => device.id !== draft.revoked);
    const wraps = await wrapTo(entropy, [...remaining, recovery], [draft.key]);
    const cutoff = draft.cutoff ?? { sequence: 0, hash: NO_HASH };
    return { kind: "revocation", revoked: draft.revoked, cutoff, epoch: draft.key.epoch, wraps };
  }

  if (draft.kind === "epoch")
    return {
      kind: "epoch",
      epoch: draft.key.epoch,
      wraps: await wrapTo(entropy, [...devices, recovery], [draft.key]),
    };

  const newest = draft.keys.at(-1);
  if (newest === undefined) throw new TypeError("a recovery rotation wraps at least the new epoch");

  const wraps = [
    ...(await wrapTo(entropy, devices, [newest])),
    ...(await wrapTo(entropy, [{ id: "recovery", wrapping: draft.recovery.wrapping }], draft.keys)),
  ];

  return { kind: "recovery", recovery: draft.recovery, epoch: newest.epoch, wraps };
}

export async function signEntryWith(
  entropy: Entropy,
  signer: Signer,
  draft: FoundingDraft | LaterDraft,
  after: Membership | undefined,
): Promise<Bytes> {
  const change = await changeOf(entropy, draft, after);
  const ref: SignerRef =
    signer.kind === "device" ? { kind: "device", id: signer.id } : { kind: "recovery" };

  const unsigned = encodeUnsigned(after?.checkpoint.head ?? NO_HASH, ref, change);
  const wire = concat(unsigned, await signAs("entry", signer.keys, unsigned));

  await apply(after, await decodeEntry(wire, after?.checkpoint.length ?? 0));

  return wire;
}

export function signEntry(signer: Signer, draft: FoundingDraft): Promise<Bytes>;
export function signEntry(signer: Signer, draft: LaterDraft, after: Membership): Promise<Bytes>;
export function signEntry(
  signer: Signer,
  draft: FoundingDraft | LaterDraft,
  after?: Membership,
): Promise<Bytes> {
  return signEntryWith(systemEntropy, signer, draft, after);
}

import { join } from "node:path";
import { eventHash, signEvent, type AuthoredEvent } from "../src/crypto/authored.ts";
import {
  checksum,
  concat,
  fromHex,
  hex,
  randomIdWith,
  type Bytes,
  type Entropy,
} from "../src/crypto/bytes.ts";
import {
  canonicalJoin,
  canonicalRequest,
  encodeInvite,
  encodeRecovery,
  joinMac,
  newInviteWith,
  recoveryKeys,
  recoverySecretWith,
} from "../src/crypto/codes.ts";
import { epochKeyWith, leaseKey, sealWith, subkey, type EpochKey } from "../src/crypto/envelope.ts";
import { signingKeysWith, sign, wrapBundleWith, wrappingKeysWith } from "../src/crypto/keys.ts";
import { rootFingerprint, signEntryWith, verifyChain } from "../src/crypto/membership.ts";
import { LABELS } from "../src/crypto/protocol.ts";

export type EntropySource = { entropy: Entropy; chunks: string[] };

export function recording(seed: number): EntropySource {
  let state = seed >>> 0 || 1;
  const chunks: string[] = [];

  const entropy: Entropy = (length) => {
    const out = new Uint8Array(length);
    for (let index = 0; index < length; index++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      out[index] = state & 0xff;
    }

    chunks.push(hex(out));

    return out;
  };

  return { entropy, chunks };
}

export function replaying(recorded: readonly string[]): EntropySource {
  const chunks: string[] = [];

  const entropy: Entropy = (length) => {
    const next = recorded[chunks.length];
    if (next === undefined || next.length !== length * 2)
      throw new Error(
        `entropy draw ${chunks.length} asked for ${length} bytes the vector does not hold`,
      );

    chunks.push(next);

    return fromHex(next);
  };

  return { entropy, chunks };
}

export type Sources = (name: string, seed: number) => EntropySource;

async function hkdfBits(secret: Uint8Array, label: string): Promise<string> {
  const base = await crypto.subtle.importKey("raw", new Uint8Array(secret), "HKDF", false, [
    "deriveBits",
  ]);

  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(),
      info: new TextEncoder().encode(label),
    },
    base,
    256,
  );

  return hex(new Uint8Array(bits));
}

const text = (value: string) => new TextEncoder().encode(value);

function hexKeys(keys: readonly EpochKey[]): { epoch: number; secret: string }[] {
  return keys.map((key) => ({ epoch: key.epoch, secret: hex(key.secret) }));
}

function hexEvent(event: AuthoredEvent): Record<string, string | number> {
  return {
    id: event.id,
    author: event.author,
    sequence: event.sequence,
    previous: hex(event.previous),
    envelope: hex(event.envelope),
    signature: hex(event.signature),
  };
}

export async function deriveVectors(sources: Sources) {
  const envelopeSource = sources("envelope", 1);
  const envelopeKey = epochKeyWith(envelopeSource.entropy, 3);
  const events = await subkey(envelopeKey, "events");
  const plaintext = "the plans history of one operator";
  const sealed = await sealWith(
    envelopeSource.entropy,
    events.key,
    3,
    text(plaintext),
    "event-0001",
  );

  const envelope = {
    entropy: envelopeSource.chunks,
    epoch: 3,
    secret: hex(envelopeKey.secret),
    nonce: envelopeSource.chunks[1] ?? "",
    associated: "event-0001",
    plaintext,
    envelope: hex(sealed),
  };

  const subkeySource = sources("subkeys", 2);
  const subkeySecret = epochKeyWith(subkeySource.entropy, 1);
  const leases = await subkey(subkeySecret, "leases");
  const subkeys = {
    entropy: subkeySource.chunks,
    secret: hex(subkeySecret.secret),
    events: await hkdfBits(subkeySecret.secret, LABELS.events),
    blobs: await hkdfBits(subkeySecret.secret, LABELS.blobs),
    labels: await hkdfBits(subkeySecret.secret, LABELS.labels),
    leases: await hkdfBits(subkeySecret.secret, LABELS.leases),
    lease: { project: "Skills", plan: "229", key: await leaseKey(leases, "Skills", "229") },
  };

  const wrapSource = sources("wrap", 3);
  const recipient = await wrappingKeysWith(wrapSource.entropy);
  const recipientId = randomIdWith(wrapSource.entropy);
  const bundleKeys = [epochKeyWith(wrapSource.entropy, 1), epochKeyWith(wrapSource.entropy, 2)];
  const wrapped = await wrapBundleWith(
    wrapSource.entropy,
    { id: recipientId, wrapping: recipient.publicKey },
    bundleKeys,
  );

  const wrap = {
    entropy: wrapSource.chunks,
    recipient: recipientId,
    wrappingSeed: wrapSource.chunks[0] ?? "",
    wrappingPublic: hex(recipient.publicKey),
    keys: hexKeys(bundleKeys),
    ephemeral: hex(wrapped.ephemeral),
    envelope: hex(wrapped.envelope),
  };

  const recoverySource = sources("recovery", 4);
  const secret = recoverySecretWith(recoverySource.entropy);
  const fingerprint = recoverySource.entropy(16);
  const identity = await recoveryKeys(secret);
  const code = await encodeRecovery(secret, fingerprint);
  const recovery = {
    entropy: recoverySource.chunks,
    secret: hex(secret),
    fingerprint: hex(fingerprint),
    code,
    checksum: hex(await checksum(concat(secret, fingerprint), 2)),
    signingPublic: hex(identity.signing.publicKey),
    wrappingPublic: hex(identity.wrapping.publicKey),
  };

  const inviteSource = sources("invite", 5);
  const checkpoint = {
    fingerprint: inviteSource.entropy(16),
    head: inviteSource.entropy(32),
    length: 7,
    epoch: 2,
  };

  const invite = newInviteWith(inviteSource.entropy, {
    checkpoint,
    expires: 1_794_096_000_000,
    label: "MacBook",
  });

  const inviteVector = {
    entropy: inviteSource.chunks,
    checkpoint: {
      fingerprint: hex(checkpoint.fingerprint),
      head: hex(checkpoint.head),
      length: 7,
      epoch: 2,
    },
    id: invite.id,
    expires: invite.expires,
    secret: hex(invite.secret),
    label: invite.label,
    text: await encodeInvite(invite),
  };

  const joinSource = sources("join", 6);
  const joiner = await signingKeysWith(joinSource.entropy);
  const joinerBox = await wrappingKeysWith(joinSource.entropy);
  const request = {
    invite: invite.id,
    device: randomIdWith(joinSource.entropy),
    signing: joiner.publicKey,
    wrapping: joinerBox.publicKey,
    nonce: randomIdWith(joinSource.entropy),
  };

  const join = {
    entropy: joinSource.chunks,
    secret: hex(invite.secret),
    invite: request.invite,
    device: request.device,
    signing: hex(request.signing),
    wrapping: hex(request.wrapping),
    nonce: request.nonce,
    canonical: hex(canonicalJoin(request)),
    mac: hex(await joinMac(invite.secret, request)),
  };

  const requestSource = sources("request", 7);
  const caller = await signingKeysWith(requestSource.entropy);
  const parts = {
    method: "POST" as const,
    path: "/v1/events?history=1",
    body: text('{"events":[]}'),
    time: 1_794_000_000_000,
    device: randomIdWith(requestSource.entropy),
    incarnation: randomIdWith(requestSource.entropy),
  };

  const canonical = await canonicalRequest(parts);
  const requestVector = {
    entropy: requestSource.chunks,
    signingPublic: hex(caller.publicKey),
    method: parts.method,
    path: parts.path,
    body: new TextDecoder().decode(parts.body),
    time: parts.time,
    device: parts.device,
    incarnation: parts.incarnation,
    canonical: new TextDecoder().decode(canonical),
    signature: hex(await sign("request", caller, canonical)),
  };

  const chainSource = sources("chain", 8);
  const founderKeys = await signingKeysWith(chainSource.entropy);
  const founderBox = await wrappingKeysWith(chainSource.entropy);
  const founderId = randomIdWith(chainSource.entropy);

  const recoverySecretBytes = recoverySecretWith(chainSource.entropy);
  const recoveryIdentity = await recoveryKeys(recoverySecretBytes);

  const epoch1 = epochKeyWith(chainSource.entropy, 1);
  const labelKey = await subkey(epoch1, "labels");
  const founderCard = {
    id: founderId,
    signing: founderKeys.publicKey,
    wrapping: founderBox.publicKey,
    label: await sealWith(chainSource.entropy, labelKey.key, 1, text("MacBook"), founderId),
  };

  const founding = await signEntryWith(
    chainSource.entropy,
    { kind: "device", id: founderId, keys: founderKeys },
    {
      kind: "founding",
      device: founderCard,
      recovery: {
        signing: recoveryIdentity.signing.publicKey,
        wrapping: recoveryIdentity.wrapping.publicKey,
      },
      key: epoch1,
    },
    undefined,
  );

  const vaultFingerprint = await rootFingerprint(founding);
  const afterFounding = await verifyChain([founding], { fingerprint: vaultFingerprint });

  const memberKeys = await signingKeysWith(chainSource.entropy);
  const memberBox = await wrappingKeysWith(chainSource.entropy);
  const memberId = randomIdWith(chainSource.entropy);
  const memberInvite = randomIdWith(chainSource.entropy);
  const memberCard = {
    id: memberId,
    signing: memberKeys.publicKey,
    wrapping: memberBox.publicKey,
    label: await sealWith(chainSource.entropy, labelKey.key, 1, text("Mac mini"), memberId),
  };

  const enrolment = await signEntryWith(
    chainSource.entropy,
    { kind: "device", id: founderId, keys: founderKeys },
    { kind: "device", device: memberCard, invite: memberInvite, keys: [epoch1] },
    afterFounding,
  );

  const afterEnrolment = await verifyChain([founding, enrolment], afterFounding.checkpoint);

  const eventKey = await subkey(epoch1, "events");
  const authored: AuthoredEvent[] = [];

  let tail: { sequence: number; hash: Bytes } | undefined;
  for (const id of ["event-0001", "event-0002", "event-0003"]) {
    const sealedEvent = await sealWith(chainSource.entropy, eventKey.key, 1, text(`row ${id}`), id);
    const signed = await signEvent({ id: memberId, keys: memberKeys }, id, sealedEvent, tail);
    authored.push(signed.event);
    tail = signed.tail;
  }

  const committed = authored[1];
  if (committed === undefined) throw new Error("the author chain holds three events");

  const cutoff = { sequence: committed.sequence, hash: await eventHash(committed) };
  const revocation = await signEntryWith(
    chainSource.entropy,
    { kind: "device", id: founderId, keys: founderKeys },
    { kind: "revocation", revoked: memberId, cutoff, key: epochKeyWith(chainSource.entropy, 2) },
    afterEnrolment,
  );

  const membership = await verifyChain(
    [founding, enrolment, revocation],
    afterEnrolment.checkpoint,
  );

  const authorChain = {
    author: memberId,
    signingPublic: hex(memberKeys.publicKey),
    epochSecret: hex(epoch1.secret),
    events: authored.map(hexEvent),
    hashes: await Promise.all(authored.map(async (event) => hex(await eventHash(event)))),
  };

  const chain = {
    entropy: chainSource.chunks,
    founder: founderId,
    member: memberId,
    entries: [founding, enrolment, revocation].map(hex),
    fingerprint: hex(vaultFingerprint),
    head: hex(membership.checkpoint.head),
    length: membership.checkpoint.length,
    epoch: membership.checkpoint.epoch,
    cutoff: { sequence: cutoff.sequence, hash: hex(cutoff.hash) },
  };

  return {
    envelope,
    subkeys,
    wrap,
    recovery,
    invite: inviteVector,
    join,
    request: requestVector,
    authorChain,
    chain,
  };
}

export type Vectors = Awaited<ReturnType<typeof deriveVectors>>;

export const VECTORS_PATH = join(import.meta.dir, "..", "src", "crypto", "vectors.json");
if (import.meta.main) {
  const vectors = await deriveVectors((_name, seed) => recording(seed));
  await Bun.write(VECTORS_PATH, `${JSON.stringify(vectors, null, 2)}\n`);
  console.log(`wrote ${VECTORS_PATH}`);
}

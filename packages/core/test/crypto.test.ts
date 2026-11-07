import { expect, test } from "bun:test";
import * as core from "skills-core";
import {
  CryptoRefusal,
  EpochKey,
  canonicalRequest,
  committedRun,
  eventHash,
  decodeInvite,
  decodeRecovery,
  encodeRecovery,
  epochKey,
  exportPrivate,
  importSigning,
  open,
  parseId,
  rootFingerprint,
  seal,
  signEntry,
  signEvent,
  signingKeys,
  subkey,
  verifyChain,
  verifyEvent,
  verifyJoin,
  wrappingKeys,
  type AuthoredEvent,
  type Membership,
  type RefusalReason,
} from "skills-core";
import { fromHex, hex, systemEntropy } from "../src/crypto/bytes.ts";
import { sealWith } from "../src/crypto/envelope.ts";
import { seeded, unwrapBundle } from "../src/crypto/keys.ts";
import vectors from "../src/crypto/vectors.json";
import { deriveVectors, replaying } from "./crypto-vectors.ts";

const recorded: Record<string, readonly string[]> = {
  envelope: vectors.envelope.entropy,
  subkeys: vectors.subkeys.entropy,
  wrap: vectors.wrap.entropy,
  recovery: vectors.recovery.entropy,
  invite: vectors.invite.entropy,
  join: vectors.join.entropy,
  request: vectors.request.entropy,
  chain: vectors.chain.entropy,
};

const sources = (name: string) => replaying(recorded[name] ?? []);

async function refusal(run: () => unknown): Promise<RefusalReason | "none"> {
  try {
    await run();
    return "none";
  } catch (error) {
    if (error instanceof CryptoRefusal) return error.reason;
    throw error;
  }
}

function eventFrom(fields: (typeof vectors.authorChain.events)[number]): AuthoredEvent {
  return {
    id: fields.id,
    author: parseId(fields.author),
    sequence: fields.sequence,
    previous: fromHex(fields.previous),
    envelope: fromHex(fields.envelope),
    signature: fromHex(fields.signature),
  };
}

async function chainMembership(): Promise<Membership> {
  return verifyChain(vectors.chain.entries.map(fromHex), {
    fingerprint: fromHex(vectors.chain.fingerprint),
  });
}

const authored = vectors.authorChain.events.map(eventFrom);

async function founderOrMemberKeys(publicHex: string) {
  const seeds = vectors.chain.entropy.filter((chunk) => chunk.length === 64);
  for (const seed of seeds) {
    const pair = await seeded("Ed25519", fromHex(seed), false);
    if (hex(pair.publicKey) === publicHex) return pair;
  }

  throw new Error("no chain seed signs with that public key");
}

test("vectors.json re derives byte for byte from the entropy each vector records", async () => {
  const derived = await deriveVectors((name) => sources(name));
  expect(JSON.parse(JSON.stringify(derived))).toEqual(vectors);
});

test("the envelope vector opens to its plaintext and is exactly 31 bytes longer", async () => {
  const { envelope } = vectors;
  const key = await subkey(new EpochKey(envelope.epoch, fromHex(envelope.secret)), "events");
  const plaintext = await open(key, fromHex(envelope.envelope), envelope.associated);

  expect(new TextDecoder().decode(plaintext)).toBe(envelope.plaintext);
  expect(fromHex(envelope.envelope).length - plaintext.length).toBe(31);
  expect(envelope.envelope.slice(6, 30)).toBe(envelope.nonce);
});

async function opensUnder(raw: string, key: core.Subkey<core.SealPurpose>) {
  const sealed = await seal(key, new Uint8Array([1, 2, 3]), "ad");
  const aes = await crypto.subtle.importKey("raw", fromHex(raw), "AES-GCM", false, ["decrypt"]);
  const { header, nonce } = core.ENVELOPE;
  const opened = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: sealed.slice(header, header + nonce),
      additionalData: new Uint8Array([...sealed.slice(0, header), 97, 100]),
    },
    aes,
    sealed.slice(header + nonce),
  );

  return [...new Uint8Array(opened)];
}

test("each subkey label derives the HKDF output its vector records", async () => {
  const { subkeys } = vectors;
  const secret = new EpochKey(1, fromHex(subkeys.secret));
  for (const purpose of ["events", "blobs", "labels"] as const)
    expect(await opensUnder(subkeys[purpose], await subkey(secret, purpose))).toEqual([1, 2, 3]);

  const leaseRaw = await crypto.subtle.importKey(
    "raw",
    fromHex(subkeys.leases),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const lease = await crypto.subtle.sign("HMAC", leaseRaw, new TextEncoder().encode("Skills/229"));

  expect(hex(new Uint8Array(lease))).toBe(subkeys.lease.key);
  expect(new Set([subkeys.events, subkeys.blobs, subkeys.labels, subkeys.leases]).size).toBe(4);
});

test("the wrap vector unwraps to its epoch keys for the recipient only", async () => {
  const { wrap } = vectors;
  const recipient = await seeded("X25519", fromHex(wrap.wrappingSeed), false);
  const bundle = {
    recipient: parseId(wrap.recipient),
    ephemeral: fromHex(wrap.ephemeral),
    envelope: fromHex(wrap.envelope),
  };

  const keys = await unwrapBundle(recipient, bundle);
  const stranger = await wrappingKeys();

  expect(hex(recipient.publicKey)).toBe(wrap.wrappingPublic);
  expect(keys.map((key) => ({ epoch: key.epoch, secret: hex(key.secret) }))).toEqual(wrap.keys);
  expect(await refusal(() => unwrapBundle(stranger, bundle))).toBe("envelope-unauthentic");
});

test("the recovery vector decodes typed from paper and names its vault", async () => {
  const { recovery } = vectors;
  const typed = recovery.code
    .toLowerCase()
    .replace(/0/g, "o")
    .replace(/1/g, "l")
    .replace(/-/g, " ");

  const decoded = await decodeRecovery(typed);
  const keys = await core.recoveryKeys(decoded.secret);

  expect(hex(decoded.secret)).toBe(recovery.secret);
  expect(hex(decoded.fingerprint)).toBe(recovery.fingerprint);

  expect(recovery.code.split("-")).toHaveLength(20);
  expect(recovery.checksum).toMatch(/^[0-9a-f]{4}$/);
  expect(await encodeRecovery(decoded.secret, decoded.fingerprint)).toBe(recovery.code);

  expect(hex(keys.signing.publicKey)).toBe(recovery.signingPublic);
  expect(hex(keys.wrapping.publicKey)).toBe(recovery.wrappingPublic);
});

test("the invite vector decodes to its checkpoint, id, expiry, secret and label", async () => {
  const { invite } = vectors;
  const decoded = await decodeInvite(invite.text.toLowerCase());

  expect(hex(decoded.checkpoint.fingerprint)).toBe(invite.checkpoint.fingerprint);
  expect(hex(decoded.checkpoint.head)).toBe(invite.checkpoint.head);
  expect([decoded.checkpoint.length, decoded.checkpoint.epoch]).toEqual([
    invite.checkpoint.length,
    invite.checkpoint.epoch,
  ]);

  expect([decoded.id, decoded.expires, decoded.label]).toEqual([
    parseId(invite.id),
    invite.expires,
    invite.label,
  ]);

  expect(hex(decoded.secret)).toBe(invite.secret);
});

function joinRequest() {
  const { join } = vectors;
  return {
    invite: parseId(join.invite),
    device: parseId(join.device),
    signing: fromHex(join.signing),
    wrapping: fromHex(join.wrapping),
    nonce: parseId(join.nonce),
  };
}

test("the join vector's MAC verifies for its invite before expiry", async () => {
  const invite = await decodeInvite(vectors.invite.text);

  expect(hex(core.canonicalJoin(joinRequest()))).toBe(vectors.join.canonical);
  expect(
    await refusal(() =>
      verifyJoin(invite, joinRequest(), fromHex(vectors.join.mac), invite.expires),
    ),
  ).toBe("none");

  expect(
    await refusal(() =>
      verifyJoin(invite, joinRequest(), fromHex(vectors.join.mac), invite.expires + 1),
    ),
  ).toBe("invite-expired");
});

test("the request vector's canonical form signs under the request domain only", async () => {
  const { request } = vectors;
  const canonical = await canonicalRequest({
    method: "POST",
    path: request.path,
    body: new TextEncoder().encode(request.body),
    time: request.time,
    device: parseId(request.device),
    incarnation: parseId(request.incarnation),
  });

  const signature = fromHex(request.signature);
  const publicKey = fromHex(request.signingPublic);

  expect(new TextDecoder().decode(canonical)).toBe(request.canonical);
  expect(await refusal(() => core.verify("request", publicKey, canonical, signature))).toBe("none");
  expect(await refusal(() => core.verify("join", publicKey, canonical, signature))).toBe(
    "signature",
  );
});

test("the three entry chain verifies to its head with the member revoked at its cutoff", async () => {
  const membership = await chainMembership();
  const member = membership.devices.get(parseId(vectors.chain.member));

  expect(hex(membership.checkpoint.head)).toBe(vectors.chain.head);
  expect([membership.checkpoint.length, membership.checkpoint.epoch]).toEqual([3, 2]);

  expect(member?.revoked?.cutoff.sequence).toBe(vectors.chain.cutoff.sequence);
  expect(hex(member?.revoked?.cutoff.hash ?? new Uint8Array())).toBe(vectors.chain.cutoff.hash);

  expect(membership.wraps.get(parseId(vectors.chain.member))).toHaveLength(1);
  expect(membership.wraps.get(parseId(vectors.chain.founder))).toHaveLength(2);
});

async function beforeRevocation(): Promise<Membership> {
  return verifyChain(vectors.chain.entries.slice(0, 2).map(fromHex), {
    fingerprint: fromHex(vectors.chain.fingerprint),
  });
}

test("the three event author chain folds while its author is a member", async () => {
  const membership = await beforeRevocation();

  let tail: { sequence: number; hash: Uint8Array<ArrayBuffer> } | undefined;
  for (const [index, event] of authored.entries()) {
    const verdict = await verifyEvent(membership, event, tail);
    if (verdict.state !== "fold") throw new Error("a member's event folds");

    expect(hex(verdict.tail.hash)).toBe(vectors.authorChain.hashes[index]!);
    tail = verdict.tail;
  }
});

test("a revoked author's events are held, and only the committed run folds", async () => {
  const membership = await chainMembership();
  const author = parseId(vectors.chain.member);

  expect((await verifyEvent(membership, authored[1]!, undefined)).state).toBe("held");
  expect((await verifyEvent(membership, authored[0]!, undefined)).state).toBe("held");
  expect(await committedRun(membership, author, [...authored].reverse())).toEqual([
    authored[0]!,
    authored[1]!,
  ]);
});

test("refuses changed associated data", async () => {
  const { envelope } = vectors;
  const key = await subkey(new EpochKey(envelope.epoch, fromHex(envelope.secret)), "events");
  expect(await refusal(() => open(key, fromHex(envelope.envelope), "event-0002"))).toBe(
    "envelope-unauthentic",
  );
});

test("refuses version byte 2", async () => {
  const { envelope } = vectors;
  const key = await subkey(new EpochKey(envelope.epoch, fromHex(envelope.secret)), "events");
  const changed = fromHex(envelope.envelope);
  changed[0] = 2;

  expect(await refusal(() => open(key, changed, envelope.associated))).toBe("envelope-version");
});

test("refuses a truncated envelope", async () => {
  const { envelope } = vectors;
  const key = await subkey(new EpochKey(envelope.epoch, fromHex(envelope.secret)), "events");
  const bytes = fromHex(envelope.envelope);

  expect(await refusal(() => open(key, bytes.slice(0, 30), envelope.associated))).toBe(
    "envelope-truncated",
  );

  expect(await refusal(() => open(key, bytes.slice(0, -1), envelope.associated))).toBe(
    "envelope-unauthentic",
  );
});

test("refuses epoch 65536", async () => {
  const key = await subkey(epochKey(1), "events");

  expect(await refusal(() => epochKey(65536))).toBe("epoch-range");
  expect(await refusal(() => sealWith(systemEntropy, key.key, 65536, new Uint8Array(), "ad"))).toBe(
    "epoch-range",
  );

  expect(await refusal(() => epochKey(65535))).toBe("none");
});

test("refuses a recovery code with one changed character", async () => {
  const { code } = vectors.recovery;
  const swap = code[0] === "Z" ? "Y" : "Z";
  expect(await refusal(() => decodeRecovery(swap + code.slice(1)))).toBe("checksum");
});

test("refuses an entry signed by a non member", async () => {
  const membership = await chainMembership();
  const outsider = { kind: "device" as const, id: core.randomId(), keys: await signingKeys() };
  const draft = { kind: "epoch" as const, key: epochKey(3) };

  expect(await refusal(() => signEntry(outsider, draft, membership))).toBe("entry-signer");
});

test("refuses a chain that does not extend the checkpoint head", async () => {
  const entries = vectors.chain.entries.map(fromHex);
  const checkpoint = {
    fingerprint: fromHex(vectors.chain.fingerprint),
    head: fromHex(vectors.authorChain.hashes[0]!),
    length: 2,
    epoch: 1,
  };

  expect(await refusal(() => verifyChain(entries, checkpoint))).toBe("chain-fork");
  expect(await refusal(() => verifyChain(entries.slice(0, 1), { ...checkpoint, length: 2 }))).toBe(
    "chain-fork",
  );
});

test("refuses a chain whose founding entry differs from the fingerprint", async () => {
  const entries = vectors.chain.entries.map(fromHex);
  const other = fromHex(vectors.invite.checkpoint.fingerprint);

  expect(await refusal(() => verifyChain(entries, { fingerprint: other }))).toBe("chain-root");
  expect(hex(await rootFingerprint(entries[0]!))).toBe(vectors.chain.fingerprint);
});

test("refuses a join request with a wrong MAC", async () => {
  const invite = await decodeInvite(vectors.invite.text);
  const mac = fromHex(vectors.join.mac);
  mac[0] = (mac[0] ?? 0) ^ 1;
  const changed = { ...joinRequest(), nonce: core.randomId() };

  expect(await refusal(() => verifyJoin(invite, joinRequest(), mac, 0))).toBe("join-mac");
  expect(await refusal(() => verifyJoin(invite, changed, fromHex(vectors.join.mac), 0))).toBe(
    "join-mac",
  );
});

test("refuses an event signature over a changed ciphertext", async () => {
  const membership = await chainMembership();
  const envelope = new Uint8Array(authored[0]!.envelope);
  envelope[20] = (envelope[20] ?? 0) ^ 1;

  expect(
    await refusal(() => verifyEvent(membership, { ...authored[0]!, envelope }, undefined)),
  ).toBe("event-signature");
});

test("refuses an event off its author chain", async () => {
  const membership = await beforeRevocation();
  const first = await verifyEvent(membership, authored[0]!, undefined);
  const tail = first.state === "fold" ? first.tail : undefined;

  expect(await refusal(() => verifyEvent(membership, authored[1]!, undefined))).toBe("event-chain");
  expect(await refusal(() => verifyEvent(membership, authored[0]!, tail))).toBe("event-chain");
});

test("refuses a revoked author's event past the committed hash", async () => {
  const membership = await chainMembership();
  const keys = await founderOrMemberKeys(vectors.authorChain.signingPublic);
  const author = { id: parseId(vectors.chain.member), keys };
  const tail = { sequence: 1, hash: fromHex(vectors.authorChain.hashes[0]!) };
  const rival = await signEvent(author, "event-rival", authored[1]!.envelope, tail);

  expect(await refusal(() => verifyEvent(membership, authored[2]!, undefined))).toBe(
    "event-cutoff",
  );

  expect(await refusal(() => verifyEvent(membership, rival.event, undefined))).toBe("event-cutoff");
});

test("a forged run below a revoked author's cutoff is left out of the committed run", async () => {
  const membership = await chainMembership();
  const author = parseId(vectors.chain.member);
  const keys = await founderOrMemberKeys(vectors.authorChain.signingPublic);
  const forged = await signEvent(
    { id: author, keys },
    authored[0]!.id,
    authored[2]!.envelope,
    undefined,
  );

  const odd = { ...authored[0]!, id: "an id with spaces" };
  const run = await committedRun(membership, author, [forged.event, odd, ...authored]);

  expect((await verifyEvent(membership, forged.event, undefined)).state).toBe("held");
  expect(run).toEqual([authored[0]!, authored[1]!]);
});

test("the authored hash is SHA-256 over newline ended id, author, sequence and previous, then the envelope", async () => {
  const event = authored[1]!;
  const head = `${event.id}\n${event.author}\n${event.sequence}\n${hex(event.previous)}\n`;
  const input = new Uint8Array([...new TextEncoder().encode(head), ...event.envelope]);
  const expected = new Uint8Array(await crypto.subtle.digest("SHA-256", input));

  expect(hex(await eventHash(event))).toBe(hex(expected));
  expect(hex(expected)).toBe(vectors.authorChain.hashes[1]!);
});

test("a device or recovery bundle missing an earlier epoch breaks a membership rule", async () => {
  const membership = await chainMembership();
  const founderId = parseId(vectors.chain.founder);
  const seeds = vectors.chain.entropy.filter((chunk) => chunk.length === 64);
  const candidates = await Promise.all(
    seeds.map((seed) => seeded("Ed25519", fromHex(seed), false)),
  );

  const keys = candidates.find(
    (pair) => hex(pair.publicKey) === hex(membership.devices.get(founderId)!.signing),
  )!;

  const signer = { kind: "device" as const, id: founderId, keys };
  const card = {
    id: core.randomId(),
    signing: (await signingKeys()).publicKey,
    wrapping: (await wrappingKeys()).publicKey,
    label: new Uint8Array(),
  };

  const device = {
    kind: "device" as const,
    device: card,
    invite: core.randomId(),
    keys: [epochKey(2)],
  };

  const recoveryCard = {
    signing: (await signingKeys()).publicKey,
    wrapping: (await wrappingKeys()).publicKey,
  };

  const recovery = { kind: "recovery" as const, recovery: recoveryCard, keys: [epochKey(3)] };

  expect(await refusal(() => signEntry(signer, device, membership))).toBe("entry-rule");
  expect(await refusal(() => signEntry(signer, recovery, membership))).toBe("entry-rule");
  expect(
    await refusal(() =>
      signEntry(signer, { ...recovery, keys: [epochKey(1), epochKey(2), epochKey(3)] }, membership),
    ),
  ).toBe("none");
});

test("a full bundle of two thousand epochs wraps past 64 KiB and unwraps whole", async () => {
  const box = await wrappingKeys();
  const keys = Array.from({ length: 2000 }, (_, index) => epochKey(index + 1));
  const wrap = await core.wrapBundle({ id: core.randomId(), wrapping: box.publicKey }, keys);

  expect(wrap.envelope.length).toBeGreaterThan(65535);
  expect((await unwrapBundle(box, wrap)).map((key) => key.epoch)).toEqual(
    keys.map((key) => key.epoch),
  );
});

test("ten thousand seals under one key never repeat a nonce", async () => {
  const key = await subkey(epochKey(1), "events");
  const nonces = new Set<string>();
  for (let index = 0; index < 10_000; index++)
    nonces.add(hex((await seal(key, new Uint8Array(), "ad")).slice(3, 15)));

  expect(nonces.size).toBe(10_000);
}, 30_000);

test("secrets never reach JSON, inspection or a spread", async () => {
  const key = epochKey(1);
  const invite = await decodeInvite(vectors.invite.text);
  const secretHex = [hex(key.secret), vectors.invite.secret];
  const shown = [
    JSON.stringify(key),
    JSON.stringify(invite),
    Bun.inspect(key),
    Bun.inspect(invite),
    JSON.stringify({ ...invite }),
  ];

  for (const text of shown) for (const secret of secretHex) expect(text).not.toContain(secret);
  expect(shown.join("")).not.toMatch(/"secret"/);
});

test("private keys leave only as pkcs8 through exportPrivate", async () => {
  const keys = await signingKeys();
  const pkcs8 = exportPrivate(keys);
  const again = await importSigning(pkcs8);

  expect(pkcs8).toHaveLength(48);
  expect(hex(again.publicKey)).toBe(hex(keys.publicKey));
  expect(keys.privateKey.extractable).toBe(false);
  expect(
    await refusal(() => crypto.subtle.exportKey("jwk", keys.privateKey)).catch(() => "thrown"),
  ).toBe("thrown");
});

test("the lease subkey derives from the founding epoch only", async () => {
  expect(await refusal(() => subkey(epochKey(2), "leases"))).toBe("epoch-mismatch");
});

test("a device card reusing an earlier device's key breaks a membership rule", async () => {
  const membership = await chainMembership();
  const founderId = parseId(vectors.chain.founder);
  const founder = membership.devices.get(founderId)!;
  const keys = await seeded("Ed25519", fromHex(vectors.chain.entropy[0]!), false);
  const card = {
    id: core.randomId(),
    signing: founder.signing,
    wrapping: (await wrappingKeys()).publicKey,
    label: new Uint8Array(),
  };

  const draft = {
    kind: "device" as const,
    device: card,
    invite: core.randomId(),
    keys: [epochKey(1), epochKey(2)],
  };

  const freshCard = { ...card, signing: (await signingKeys()).publicKey };
  const signer = { kind: "device" as const, id: founderId, keys };

  expect(hex(keys.publicKey)).toBe(hex(founder.signing));
  expect(await refusal(() => signEntry(signer, draft, membership))).toBe("entry-rule");
  expect(await refusal(() => signEntry(signer, { ...draft, device: freshCard }, membership))).toBe(
    "none",
  );
});

test("a revoked device can sign no entry", async () => {
  const membership = await chainMembership();
  const seeds = vectors.chain.entropy.filter((chunk) => chunk.length === 64);
  const candidates = await Promise.all(
    seeds.map((seed) => seeded("Ed25519", fromHex(seed), false)),
  );

  const keys = candidates.find((pair) => hex(pair.publicKey) === vectors.authorChain.signingPublic);
  const signer = { kind: "device" as const, id: parseId(vectors.chain.member), keys: keys! };

  expect(keys).toBeDefined();
  expect(
    await refusal(() => signEntry(signer, { kind: "epoch", key: epochKey(3) }, membership)),
  ).toBe("entry-signer");
});

function chainWires(): Uint8Array<ArrayBuffer>[] {
  return vectors.chain.entries.map(fromHex);
}

const vault = () => ({ fingerprint: fromHex(vectors.chain.fingerprint) });

async function founderSigner() {
  const membership = await chainMembership();
  const id = parseId(vectors.chain.founder);
  const keys = await founderOrMemberKeys(hex(membership.devices.get(id)!.signing));
  return { membership, signer: { kind: "device" as const, id, keys } };
}

async function newCard(): Promise<core.DeviceCard> {
  return {
    id: core.randomId(),
    signing: (await signingKeys()).publicKey,
    wrapping: (await wrappingKeys()).publicKey,
    label: new Uint8Array(),
  };
}

test("verifyChain refuses a hub that reorders, tampers with or misdates entries", async () => {
  const [founding, enrolment, revocation] = chainWires();
  const tampered = new Uint8Array(revocation!);
  tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1;

  const head = fromHex(vectors.chain.head);
  const misdated = { ...vault(), head, length: 3, epoch: 9 };

  expect(await refusal(() => verifyChain([founding!, revocation!], vault()))).toBe("chain-link");
  expect(await refusal(() => verifyChain([founding!, enrolment!, tampered], vault()))).toBe(
    "entry-signature",
  );

  expect(await refusal(() => verifyChain(chainWires(), misdated))).toBe("chain-fork");
  expect(await refusal(() => verifyChain(chainWires(), { ...misdated, epoch: 2 }))).toBe("none");
});

test("an epoch entry and a recovery enrolment extend the chain", async () => {
  const { membership, signer } = await founderSigner();
  const epoch = await signEntry(signer, { kind: "epoch", key: epochKey(3) }, membership);
  const afterEpoch = await verifyChain([...chainWires(), epoch], membership.checkpoint);
  const recovery = await core.recoveryKeys(fromHex(vectors.chain.entropy[3]!));
  const recoverySigner = { kind: "recovery" as const, keys: recovery.signing };
  const draft = {
    kind: "device" as const,
    device: await newCard(),
    invite: null,
    keys: [epochKey(1), epochKey(2), epochKey(3)],
  };

  const enrolment = await signEntry(recoverySigner, draft, afterEpoch);
  const final = await verifyChain([...chainWires(), epoch, enrolment], afterEpoch.checkpoint);

  expect(hex(recovery.signing.publicKey)).toBe(hex(membership.recovery.signing));
  expect([final.checkpoint.length, final.checkpoint.epoch]).toEqual([5, 3]);
  expect(final.devices.get(draft.device.id)?.joined.epoch).toBe(3);
});

test("an invite enrols once, and the recovery identity enrols only without one", async () => {
  const { membership, signer } = await founderSigner();
  const used = membership.entries[1]!.change;
  if (used.kind !== "device" || used.invite === null) throw new Error("entry 1 enrols by invite");

  const keys = [epochKey(1), epochKey(2)];
  const reuse = { kind: "device" as const, device: await newCard(), invite: used.invite, keys };
  const recovery = await core.recoveryKeys(fromHex(vectors.chain.entropy[3]!));
  const recoverySigner = { kind: "recovery" as const, keys: recovery.signing };
  const withInvite = { ...reuse, device: await newCard(), invite: core.randomId() };

  expect(await refusal(() => signEntry(signer, reuse, membership))).toBe("entry-rule");
  expect(await refusal(() => signEntry(recoverySigner, withInvite, membership))).toBe(
    "entry-signer",
  );

  expect(await refusal(() => signEntry(signer, { ...withInvite }, membership))).toBe("none");
});

test("verifyJoin refuses to judge expiry against a time that is not a number", async () => {
  const invite = await decodeInvite(vectors.invite.text);
  const run = () => verifyJoin(invite, joinRequest(), fromHex(vectors.join.mac), Number.NaN);
  expect(run()).rejects.toThrow(TypeError);
});

test("skills-core exposes no deterministic core that takes a nonce or entropy", () => {
  const names = Object.keys(core);

  expect(names.filter((name) => name.endsWith("With"))).toEqual([]);
  expect(names).toContain("PROTOCOL");
  expect(core.PROTOCOL).toBe(1);
});

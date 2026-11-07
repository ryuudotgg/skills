import {
  Reader,
  checksum,
  concat,
  equal,
  fromBase32,
  fromUtf8,
  hex,
  idBytes,
  idText,
  own,
  parseId,
  randomIdWith,
  sha256,
  systemEntropy,
  toBase32,
  u16,
  u32,
  u64,
  u8,
  utf8,
  type Bytes,
  type Entropy,
  type Id,
} from "./bytes.ts";
import { seeded, type SigningKeys, type WrappingKeys } from "./keys.ts";
import { INVITE, LABELS, LAYOUT, RECOVERY, checkEpoch, refuse } from "./protocol.ts";

export type Checkpoint = {
  readonly fingerprint: Bytes;
  readonly head: Bytes;
  readonly length: number;
  readonly epoch: number;
};

export type InviteTerms = {
  readonly checkpoint: Checkpoint;
  readonly expires: number;
  readonly label: string;
};

export class Invite {
  readonly checkpoint: Checkpoint;
  readonly id: Id;
  readonly expires: number;
  readonly label: string;
  readonly #secret: Bytes;

  constructor(terms: InviteTerms & { readonly id: Id }, secret: Uint8Array) {
    if (secret.length !== LAYOUT.id) refuse("malformed");

    this.checkpoint = terms.checkpoint;
    this.id = terms.id;
    this.expires = terms.expires;
    this.label = terms.label;
    this.#secret = own(secret);
  }

  get secret(): Bytes {
    return this.#secret;
  }
}

export class RecoveryCode {
  readonly fingerprint: Bytes;
  readonly #secret: Bytes;

  constructor(fingerprint: Uint8Array, secret: Uint8Array) {
    this.fingerprint = own(fingerprint);
    this.#secret = own(secret);
  }

  get secret(): Bytes {
    return this.#secret;
  }
}

export type JoinRequest = {
  readonly invite: Id;
  readonly device: Id;
  readonly signing: Uint8Array;
  readonly wrapping: Uint8Array;
  readonly nonce: Id;
};

export type RequestParts = {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly body: Uint8Array;
  readonly time: number;
  readonly device: Id | "recovery";
  readonly incarnation: Id;
};

const RECOVERY_BYTES = LAYOUT.key + LAYOUT.fingerprint + RECOVERY.checksum;

export function recoverySecretWith(entropy: Entropy): Bytes {
  return entropy(LAYOUT.key);
}

export function recoverySecret(): Bytes {
  return recoverySecretWith(systemEntropy);
}

async function recoverySeed(secret: Uint8Array, label: string): Promise<Bytes> {
  if (secret.length !== LAYOUT.key) refuse("malformed");

  const base = await crypto.subtle.importKey("raw", own(secret), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: utf8(label) },
    base,
    LAYOUT.key * 8,
  );

  return new Uint8Array(bits);
}

export async function recoveryKeys(
  secret: Uint8Array,
): Promise<{ signing: SigningKeys; wrapping: WrappingKeys }> {
  const signing = await seeded("Ed25519", await recoverySeed(secret, LABELS.recoverSign), false);
  const wrapping = await seeded("X25519", await recoverySeed(secret, LABELS.recoverWrap), false);
  return { signing, wrapping };
}

export async function encodeRecovery(secret: Uint8Array, fingerprint: Uint8Array): Promise<string> {
  if (secret.length !== LAYOUT.key || fingerprint.length !== LAYOUT.fingerprint)
    refuse("malformed");

  const body = concat(secret, fingerprint);
  const text = toBase32(concat(body, await checksum(body, RECOVERY.checksum)));
  return (text.match(new RegExp(`.{${RECOVERY.group}}`, "g")) ?? []).join(RECOVERY.separator);
}

export async function decodeRecovery(code: string): Promise<RecoveryCode> {
  const reader = new Reader(fromBase32(code, RECOVERY_BYTES));
  const body = reader.take(LAYOUT.key + LAYOUT.fingerprint);
  const sum = reader.take(RECOVERY.checksum);
  reader.end();
  if (!equal(sum, await checksum(body, RECOVERY.checksum))) refuse("checksum");

  return new RecoveryCode(body.slice(LAYOUT.key), body.slice(0, LAYOUT.key));
}

export function newInviteWith(entropy: Entropy, terms: InviteTerms): Invite {
  return new Invite({ ...terms, id: randomIdWith(entropy) }, entropy(LAYOUT.id));
}

export function newInvite(terms: {
  checkpoint: Checkpoint;
  expires: number;
  label: string;
}): Invite {
  return newInviteWith(systemEntropy, terms);
}

function inviteBody(invite: Invite): Bytes {
  const { checkpoint } = invite;
  const label = utf8(invite.label);
  if (label.length > INVITE.maxLabel)
    throw new RangeError("an invite label holds at most 64 bytes");

  if (
    checkpoint.fingerprint.length !== LAYOUT.fingerprint ||
    checkpoint.head.length !== LAYOUT.hash
  )
    refuse("malformed");

  return concat(
    [INVITE.version],
    checkpoint.fingerprint,
    checkpoint.head,
    u32(checkpoint.length),
    u16(checkEpoch(checkpoint.epoch)),
    idBytes(invite.id),
    u64(invite.expires),
    invite.secret,
    u8(label.length),
    label,
  );
}

export async function encodeInvite(invite: Invite): Promise<string> {
  const body = inviteBody(invite);
  return toBase32(concat(body, await checksum(body, INVITE.checksum)));
}

export async function decodeInvite(text: string): Promise<Invite> {
  const bytes = fromBase32(text);
  if (bytes.length < INVITE.checksum) refuse("malformed");

  const body = bytes.slice(0, -INVITE.checksum);
  if (!equal(bytes.slice(-INVITE.checksum), await checksum(body, INVITE.checksum)))
    refuse("checksum");

  const reader = new Reader(body);
  if (reader.u8() !== INVITE.version) refuse("malformed");

  const fingerprint = reader.take(LAYOUT.fingerprint);
  const head = reader.take(LAYOUT.hash);
  const length = reader.u32();
  const epoch = checkEpoch(reader.u16());

  const id = idText(reader.take(LAYOUT.id));
  const expires = reader.u64();
  const secret = reader.take(LAYOUT.id);
  const labelLength = reader.u8();
  if (labelLength > INVITE.maxLabel) refuse("malformed");

  const label = fromUtf8(reader.take(labelLength));
  reader.end();

  return new Invite(
    { checkpoint: { fingerprint, head, length, epoch }, id, expires, label },
    secret,
  );
}

export function canonicalJoin(request: JoinRequest): Bytes {
  if (request.signing.length !== LAYOUT.key || request.wrapping.length !== LAYOUT.key)
    refuse("malformed");

  return concat(
    [LAYOUT.version],
    idBytes(request.invite),
    idBytes(request.device),
    request.signing,
    request.wrapping,
    idBytes(request.nonce),
  );
}

function macKey(secret: Uint8Array, usage: "sign" | "verify"): Promise<CryptoKey> {
  if (secret.length !== LAYOUT.id) refuse("malformed");
  return crypto.subtle.importKey("raw", own(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    usage,
  ]);
}

export async function joinMac(secret: Uint8Array, request: JoinRequest): Promise<Bytes> {
  const mac = await crypto.subtle.sign(
    "HMAC",
    await macKey(secret, "sign"),
    canonicalJoin(request),
  );

  return new Uint8Array(mac);
}

export async function verifyJoin(
  invite: Invite,
  request: JoinRequest,
  mac: Uint8Array,
  now: number,
): Promise<void> {
  if (!Number.isSafeInteger(now)) throw new TypeError("now is a whole number of unix milliseconds");
  if (request.invite !== invite.id) refuse("invite-mismatch");
  if (now > invite.expires) refuse("invite-expired");

  const key = await macKey(invite.secret, "verify");
  if (!(await crypto.subtle.verify("HMAC", key, own(mac), canonicalJoin(request))))
    refuse("join-mac");
}

export async function canonicalRequest(parts: RequestParts): Promise<Bytes> {
  if (!/^\/[\x21-\x7e]*$/.test(parts.path)) refuse("malformed");
  if (!Number.isSafeInteger(parts.time) || parts.time < 0) refuse("malformed");

  const fields = [
    parts.method,
    parts.path,
    hex(await sha256(parts.body)),
    String(parts.time),
    parts.device === "recovery" ? parts.device : parseId(parts.device),
    parseId(parts.incarnation),
  ];

  return utf8(fields.map((field) => `${field}\n`).join(""));
}

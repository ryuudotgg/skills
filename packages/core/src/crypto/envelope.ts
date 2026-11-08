import { concat, hex, own, systemEntropy, u16, utf8, type Bytes, type Entropy } from "./bytes.ts";
import { ENVELOPE, LABELS, LAYOUT, checkEpoch, refuse } from "./protocol.ts";

export class EpochKey {
  readonly epoch: number;
  readonly #secret: Bytes;

  constructor(epoch: number, secret: Uint8Array) {
    if (secret.length !== LAYOUT.key) refuse("malformed");
    this.epoch = checkEpoch(epoch);
    this.#secret = own(secret);
  }

  get secret(): Bytes {
    return this.#secret;
  }
}

export type SealPurpose = "events" | "blobs" | "labels";

export type Purpose = SealPurpose | "leases";

export type Subkey<P extends Purpose> = {
  readonly purpose: P;
  readonly epoch: number;
  readonly key: CryptoKey;
};

const AES = { name: "AES-GCM", length: 256 } as const;

const HMAC = { name: "HMAC", hash: "SHA-256", length: 256 } as const;

export function epochKeyWith(entropy: Entropy, epoch: number): EpochKey {
  return new EpochKey(epoch, entropy(LAYOUT.key));
}

export function epochKey(epoch: number): EpochKey {
  return epochKeyWith(systemEntropy, epoch);
}

type Derived = { algorithm: typeof AES | typeof HMAC; usages: KeyUsage[] };

const DERIVED: Record<"aes" | "hmac", Derived> = {
  aes: { algorithm: AES, usages: ["encrypt", "decrypt"] },
  hmac: { algorithm: HMAC, usages: ["sign"] },
};

export async function hkdf(
  secret: Uint8Array,
  label: string,
  salt: Uint8Array = new Uint8Array(),
  into: Derived = DERIVED.aes,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", own(secret), "HKDF", false, ["deriveKey"]);
  const params = { name: "HKDF", hash: "SHA-256", salt: own(salt), info: utf8(label) };
  return crypto.subtle.deriveKey(params, base, into.algorithm, false, into.usages);
}

export async function subkey<P extends Purpose>(key: EpochKey, purpose: P): Promise<Subkey<P>> {
  if (purpose === "leases" && key.epoch !== 1) refuse("epoch-mismatch");

  const into = purpose === "leases" ? DERIVED.hmac : DERIVED.aes;
  const derived = await hkdf(key.secret, LABELS[purpose], new Uint8Array(), into);
  return { purpose, epoch: key.epoch, key: derived };
}

function header(epoch: number): Bytes {
  return concat([ENVELOPE.version], u16(checkEpoch(epoch)));
}

export async function sealWith(
  entropy: Entropy,
  key: CryptoKey,
  epoch: number,
  plaintext: Uint8Array,
  associated: string,
): Promise<Bytes> {
  const head = header(epoch);
  const nonce = entropy(ENVELOPE.nonce);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: concat(head, utf8(associated)) },
    key,
    own(plaintext),
  );

  return concat(head, nonce, new Uint8Array(ciphertext));
}

export function seal(
  key: Subkey<SealPurpose>,
  plaintext: Uint8Array,
  associated: string,
): Promise<Bytes> {
  return sealWith(systemEntropy, key.key, key.epoch, plaintext, associated);
}

export function envelopeEpoch(envelope: Uint8Array): number {
  if (envelope.length < ENVELOPE.overhead) refuse("envelope-truncated");
  if (envelope[0] !== ENVELOPE.version) refuse("envelope-version");
  return checkEpoch(((envelope[1] ?? 0) << 8) | (envelope[2] ?? 0));
}

export async function openWith(
  key: CryptoKey,
  epoch: number,
  envelope: Uint8Array,
  associated: string,
): Promise<Bytes> {
  if (envelopeEpoch(envelope) !== epoch) refuse("epoch-mismatch");

  const bytes = own(envelope);
  const head = bytes.slice(0, ENVELOPE.header);
  const nonce = bytes.slice(ENVELOPE.header, ENVELOPE.header + ENVELOPE.nonce);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: concat(head, utf8(associated)) },
      key,
      bytes.slice(ENVELOPE.header + ENVELOPE.nonce),
    );

    return new Uint8Array(plaintext);
  } catch {
    return refuse("envelope-unauthentic");
  }
}

export function open(
  key: Subkey<SealPurpose>,
  envelope: Uint8Array,
  associated: string,
): Promise<Bytes> {
  return openWith(key.key, key.epoch, envelope, associated);
}

export async function leaseKey(
  leases: Subkey<"leases">,
  project: string,
  plan: string,
): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", leases.key, utf8(`${project}/${plan}`));
  return hex(new Uint8Array(mac));
}

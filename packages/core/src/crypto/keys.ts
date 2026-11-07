import {
  Reader,
  concat,
  equal,
  fromHex,
  own,
  systemEntropy,
  u16,
  utf8,
  type Bytes,
  type Entropy,
  type Id,
} from "./bytes.ts";
import { EpochKey, envelopeEpoch, hkdf, openWith, sealWith } from "./envelope.ts";
import { DOMAINS, LABELS, LAYOUT, checkEpoch, refuse } from "./protocol.ts";

type Curve = "Ed25519" | "X25519";

export type SigningKeys = { readonly privateKey: CryptoKey; readonly publicKey: Bytes };

export type WrappingKeys = { readonly privateKey: CryptoKey; readonly publicKey: Bytes };

export type Domain = keyof typeof DOMAINS;

export type Recipient = Id | "recovery";

export type Wrap = {
  readonly recipient: Recipient;
  readonly ephemeral: Bytes;
  readonly envelope: Bytes;
};

const PKCS8_PREFIX: Record<Curve, Bytes> = {
  Ed25519: fromHex("302e020100300506032b657004220420"),
  X25519: fromHex("302e020100300506032b656e04220420"),
};

const USAGES: Record<Curve, KeyUsage[]> = { Ed25519: ["sign"], X25519: ["deriveBits"] };

function fromBase64Url(text: string): Bytes {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

const X25519_BASE: Bytes = Uint8Array.from({ length: LAYOUT.key }, (_, index) =>
  index === 0 ? 9 : 0,
);

async function publicOf(curve: Curve, pkcs8: Bytes, privateKey: CryptoKey): Promise<Bytes> {
  if (curve === "X25519") {
    const base = await crypto.subtle.importKey("raw", X25519_BASE, "X25519", false, []);
    return new Uint8Array(
      await crypto.subtle.deriveBits({ name: "X25519", public: base }, privateKey, 256),
    );
  }

  const probe = await crypto.subtle.importKey("pkcs8", pkcs8, curve, true, USAGES[curve]);
  const { x } = await crypto.subtle.exportKey("jwk", probe);
  if (x === undefined) return refuse("malformed");

  return fromBase64Url(x);
}

const PKCS8 = new WeakMap<CryptoKey, Bytes>();
export async function seeded(
  curve: Curve,
  seed: Uint8Array,
  exportable: boolean,
): Promise<{ privateKey: CryptoKey; publicKey: Bytes }> {
  if (seed.length !== LAYOUT.key) refuse("malformed");

  const pkcs8 = concat(PKCS8_PREFIX[curve], seed);
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, curve, false, USAGES[curve]);
  const publicKey = await publicOf(curve, pkcs8, privateKey);
  if (exportable) PKCS8.set(privateKey, pkcs8);

  return { privateKey, publicKey };
}

export function signingKeysWith(entropy: Entropy): Promise<SigningKeys> {
  return seeded("Ed25519", entropy(LAYOUT.key), true);
}

export function signingKeys(): Promise<SigningKeys> {
  return signingKeysWith(systemEntropy);
}

export function wrappingKeysWith(entropy: Entropy): Promise<WrappingKeys> {
  return seeded("X25519", entropy(LAYOUT.key), true);
}

export function wrappingKeys(): Promise<WrappingKeys> {
  return wrappingKeysWith(systemEntropy);
}

export function exportPrivate(keys: SigningKeys | WrappingKeys): Bytes {
  const pkcs8 = PKCS8.get(keys.privateKey);
  if (pkcs8 === undefined) throw new TypeError("this private key is not exportable");
  return own(pkcs8);
}

function seedOf(curve: Curve, pkcs8: Uint8Array): Bytes {
  const prefix = PKCS8_PREFIX[curve];
  if (pkcs8.length !== prefix.length + LAYOUT.key || !equal(pkcs8.slice(0, prefix.length), prefix))
    refuse("malformed");

  return own(pkcs8.slice(prefix.length));
}

export function importSigning(pkcs8: Uint8Array): Promise<SigningKeys> {
  return seeded("Ed25519", seedOf("Ed25519", pkcs8), true);
}

export function importWrapping(pkcs8: Uint8Array): Promise<WrappingKeys> {
  return seeded("X25519", seedOf("X25519", pkcs8), true);
}

function domainMessage(domain: Domain, message: Uint8Array): Bytes {
  return concat(utf8(DOMAINS[domain]), [0], message);
}

export async function signAs(
  domain: Domain,
  keys: SigningKeys,
  message: Uint8Array,
): Promise<Bytes> {
  const signature = await crypto.subtle.sign(
    "Ed25519",
    keys.privateKey,
    domainMessage(domain, message),
  );

  return new Uint8Array(signature);
}

export async function verifies(
  domain: Domain,
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  if (publicKey.length !== LAYOUT.key || signature.length !== LAYOUT.signature) return false;

  try {
    const key = await crypto.subtle.importKey("raw", own(publicKey), "Ed25519", false, ["verify"]);
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      own(signature),
      domainMessage(domain, message),
    );
  } catch {
    return false;
  }
}

export function sign(
  domain: "request" | "join",
  keys: SigningKeys,
  message: Uint8Array,
): Promise<Bytes> {
  return signAs(domain, keys, message);
}

export async function verify(
  domain: "request" | "join",
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<void> {
  if (!(await verifies(domain, publicKey, message, signature))) refuse("signature");
}

async function wrapKey(
  privateKey: CryptoKey,
  peer: Uint8Array,
  ephemeral: Uint8Array,
  recipient: Uint8Array,
): Promise<CryptoKey> {
  const publicKey = await crypto.subtle.importKey("raw", own(peer), "X25519", false, []);
  const shared = await crypto.subtle.deriveBits(
    { name: "X25519", public: publicKey },
    privateKey,
    256,
  );

  return hkdf(new Uint8Array(shared), LABELS.wrap, concat(ephemeral, recipient));
}

function wrapAssociated(epoch: number, recipient: Recipient): string {
  return `vault/${epoch}/${recipient}`;
}

export function bundlePlaintext(keys: readonly EpochKey[]): Bytes {
  const ascending = keys.every(
    (key, index) => index === 0 || key.epoch > (keys[index - 1]?.epoch ?? 0),
  );

  if (keys.length === 0 || !ascending || keys.some((key) => key.secret.length !== LAYOUT.key))
    throw new RangeError("a bundle holds one or more 32 byte epoch keys in ascending order");

  return concat(u16(keys.length), ...keys.map((key) => concat(u16(key.epoch), key.secret)));
}

export async function wrapBundleWith(
  entropy: Entropy,
  recipient: { readonly id: Recipient; readonly wrapping: Uint8Array },
  keys: readonly EpochKey[],
): Promise<Wrap> {
  const plaintext = bundlePlaintext(keys);
  const epoch = keys.at(-1)?.epoch ?? 0;
  const ephemeral = await seeded("X25519", entropy(LAYOUT.key), false);
  const key = await wrapKey(
    ephemeral.privateKey,
    recipient.wrapping,
    ephemeral.publicKey,
    recipient.wrapping,
  );

  const envelope = await sealWith(
    entropy,
    key,
    epoch,
    plaintext,
    wrapAssociated(epoch, recipient.id),
  );

  return { recipient: recipient.id, ephemeral: ephemeral.publicKey, envelope };
}

export function wrapBundle(
  recipient: { readonly id: Recipient; readonly wrapping: Uint8Array },
  keys: readonly EpochKey[],
): Promise<Wrap> {
  return wrapBundleWith(systemEntropy, recipient, keys);
}

export async function unwrapBundle(keys: WrappingKeys, wrap: Wrap): Promise<EpochKey[]> {
  const epoch = envelopeEpoch(wrap.envelope);
  const key = await wrapKey(keys.privateKey, wrap.ephemeral, wrap.ephemeral, keys.publicKey).catch(
    () => refuse("bundle-malformed"),
  );

  const plaintext = await openWith(
    key,
    epoch,
    wrap.envelope,
    wrapAssociated(epoch, wrap.recipient),
  );

  const reader = new Reader(plaintext);
  const count = reader.u16();
  const out: EpochKey[] = [];
  for (let index = 0; index < count; index++) {
    const keyEpoch = checkEpoch(reader.u16());
    if (keyEpoch <= (out.at(-1)?.epoch ?? 0)) refuse("bundle-malformed");
    out.push(new EpochKey(keyEpoch, reader.take(LAYOUT.key)));
  }

  reader.end();
  if (out.length === 0 || out.at(-1)?.epoch !== epoch) refuse("bundle-malformed");

  return out;
}

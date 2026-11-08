import { LAYOUT, refuse } from "./protocol.ts";

export type Bytes = Uint8Array<ArrayBuffer>;

export type Entropy = (length: number) => Bytes;

declare const idBrand: unique symbol;

export type Id = string & { readonly [idBrand]: true };

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const LOOK_ALIKES: Record<string, string> = { O: "0", I: "1", L: "1" };

export const systemEntropy: Entropy = (length) => crypto.getRandomValues(new Uint8Array(length));

export function own(bytes: Uint8Array): Bytes {
  return new Uint8Array(bytes);
}

export function concat(...parts: readonly ArrayLike<number>[]): Bytes {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));

  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
}

type Width = 1 | 2 | 4 | 8;

const WRITERS: Record<Width, (view: DataView, value: number) => void> = {
  1: (view, value) => view.setUint8(0, value),
  2: (view, value) => view.setUint16(0, value),
  4: (view, value) => view.setUint32(0, value),
  8: (view, value) => view.setBigUint64(0, BigInt(value)),
};

function unsigned(value: number, size: Width): Bytes {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** (size * 8))
    throw new RangeError(`${value} does not fit in ${size} bytes`);

  const out = new Uint8Array(size);
  WRITERS[size](new DataView(out.buffer), value);

  return out;
}

export const u8 = (value: number) => unsigned(value, 1);
export const u16 = (value: number) => unsigned(value, 2);
export const u32 = (value: number) => unsigned(value, 4);
export const u64 = (value: number) => unsigned(value, 8);

export function utf8(text: string): Bytes {
  return new TextEncoder().encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return refuse("malformed");
  }
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function fromHex(text: string): Bytes {
  if (!/^(?:[0-9a-f]{2})*$/.test(text)) refuse("malformed");
  return Uint8Array.from(text.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

export function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export async function sha256(bytes: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", own(bytes)));
}

export async function checksum(bytes: Uint8Array, size: number): Promise<Bytes> {
  return (await sha256(bytes)).slice(0, size);
}

function isId(text: string): text is Id {
  return /^[0-9a-f]{32}$/.test(text);
}

export function parseId(text: string): Id {
  if (!isId(text)) return refuse("malformed");
  return text;
}

export function idText(bytes: Uint8Array): Id {
  return parseId(hex(bytes));
}

export function idBytes(id: Id): Bytes {
  return fromHex(id);
}

export function randomIdWith(entropy: Entropy): Id {
  return idText(entropy(LAYOUT.id));
}

export function randomId(): Id {
  return randomIdWith(systemEntropy);
}

export const blobId = randomId;

export function toBase32(bytes: Uint8Array): string {
  let bits = 0;
  let buffer = 0;
  let out = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(buffer >> bits) & 31];
    }

    buffer &= (1 << bits) - 1;
  }

  return bits > 0 ? out + CROCKFORD[(buffer << (5 - bits)) & 31] : out;
}

export function normaliseBase32(text: string): string {
  return text
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[OIL]/g, (character) => LOOK_ALIKES[character] ?? character);
}

export function fromBase32(text: string, expected?: number): Bytes {
  const normal = normaliseBase32(text);
  const length = expected ?? Math.floor((normal.length * 5) / 8);
  if (normal.length !== Math.ceil((length * 8) / 5)) refuse("malformed");

  const out = new Uint8Array(length);

  let bits = 0;
  let buffer = 0;
  let index = 0;
  for (const character of normal) {
    const value = CROCKFORD.indexOf(character);
    if (value < 0) refuse("malformed");

    buffer = ((buffer << 5) | value) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (buffer >> bits) & 0xff;
    }
  }

  if ((buffer & ((1 << bits) - 1)) !== 0) refuse("malformed");

  return out;
}

export class Reader {
  #bytes: Bytes;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = own(bytes);
  }

  take(length: number): Bytes {
    if (this.#offset + length > this.#bytes.length) refuse("malformed");

    const out = this.#bytes.slice(this.#offset, this.#offset + length);
    this.#offset += length;

    return out;
  }

  #unsigned(size: number): number {
    const view = new DataView(this.take(size).buffer);
    if (size === 1) return view.getUint8(0);
    if (size === 2) return view.getUint16(0);
    if (size === 4) return view.getUint32(0);

    const value = view.getBigUint64(0);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) refuse("malformed");

    return Number(value);
  }

  u8(): number {
    return this.#unsigned(1);
  }

  u16(): number {
    return this.#unsigned(2);
  }

  u32(): number {
    return this.#unsigned(4);
  }

  u64(): number {
    return this.#unsigned(8);
  }

  rest(): Bytes {
    return this.take(this.#bytes.length - this.#offset);
  }

  end(): void {
    if (this.#offset !== this.#bytes.length) refuse("malformed");
  }
}

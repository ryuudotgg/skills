import {
  ENVELOPE,
  LAYOUT,
  envelopeEpoch,
  fromHex,
  hex,
  parseId,
  type AuthoredEvent,
  type Bytes,
  type Id,
} from "skills-core";
import { Refusal } from "./refusal.ts";

export type Json = Readonly<Record<string, unknown>>;

type EventWire = {
  readonly id: string;
  readonly author: string;
  readonly sequence: number;
  readonly previous: string;
  readonly envelope: string;
  readonly signature: string;
};

const EVENT_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function malformed(field?: string): never {
  throw new Refusal("malformed", field === undefined ? {} : { field });
}

export function parseBody(body: Bytes, keys: readonly string[]): Json {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return malformed();
  }

  return shape(value, keys);
}

export function shape(value: unknown, keys: readonly string[]): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return malformed();

  const record = value as Json;
  const extra = Object.keys(record).find((key) => !keys.includes(key));
  if (extra !== undefined) malformed(extra);

  return record;
}

export function text(record: Json, key: string): string {
  const value = record[key];
  if (typeof value !== "string") return malformed(key);
  return value;
}

export function list(record: Json, key: string, max: number): readonly unknown[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length > max) return malformed(key);
  return value;
}

export function count(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return malformed(field);

  return value;
}

export function queryCount(value: string | null, fallback: number, field: string): number {
  if (value === null) return fallback;
  if (!/^\d{1,16}$/.test(value)) return malformed(field);
  return count(Number(value), field);
}

export function same(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left.buffer, left.byteOffset, left.byteLength).equals(right);
}

export function flag(record: Json, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") return malformed(key);
  return value;
}

export function base64(value: unknown, field: string, length?: number): Bytes {
  if (typeof value !== "string" || value.length % 4 !== 0 || !BASE64.test(value))
    return malformed(field);

  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (length !== undefined && bytes.length !== length) malformed(field);

  return bytes;
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function hexOf(value: unknown, field: string, length: number): Bytes {
  if (typeof value !== "string" || value.length !== length * 2 || !/^[0-9a-f]*$/.test(value))
    return malformed(field);

  return fromHex(value);
}

export function idOf(value: unknown, field: string): Id {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/.test(value)) return malformed(field);
  return parseId(value);
}

export function eventIdOf(value: unknown, field: string): string {
  if (typeof value !== "string" || !EVENT_ID.test(value)) return malformed(field);
  return value;
}

export function envelopeOf(value: unknown, field: string, max: number): Bytes {
  const bytes = base64(value, field);
  if (bytes.length < ENVELOPE.overhead) malformed(field);
  if (bytes.length > max) throw new Refusal("too-large", { field });

  envelopeEpoch(bytes);
  return bytes;
}

export function eventOf(value: unknown, max: number): AuthoredEvent {
  const record = shape(value, ["id", "author", "sequence", "previous", "envelope", "signature"]);
  const sequence = count(record.sequence, "sequence");
  if (sequence < 1) malformed("sequence");

  return {
    id: eventIdOf(record.id, "id"),
    author: idOf(record.author, "author"),
    sequence,
    previous: hexOf(record.previous, "previous", LAYOUT.hash),
    envelope: envelopeOf(record.envelope, "envelope", max),
    signature: base64(record.signature, "signature", LAYOUT.signature),
  };
}

export function eventWire(event: AuthoredEvent): EventWire {
  return {
    id: event.id,
    author: event.author,
    sequence: event.sequence,
    previous: hex(event.previous),
    envelope: toBase64(event.envelope),
    signature: toBase64(event.signature),
  };
}

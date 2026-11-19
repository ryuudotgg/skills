import type { Bytes } from "skills-core";
import { Offline } from "./network.ts";

export function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

export function bytes(value: unknown): Bytes {
  if (typeof value !== "string") throw new Offline("the hub sent bytes that are not base64");
  return new Uint8Array(Buffer.from(value, "base64"));
}

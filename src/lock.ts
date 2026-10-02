import { closeSync, openSync } from "node:fs";
import { dlopen, FFIType } from "bun:ffi";

const LOCK_WAIT = 10_000;
const LOCK_EX = 2;
const LOCK_NB = 4;
let libc: { flock(descriptor: number, operation: number): number } | undefined;

function flock(descriptor: number, operation: number): boolean {
  libc ??= dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  }).symbols;

  return libc.flock(descriptor, operation) === 0;
}

export async function withLock<T>(
  path: string,
  label: string,
  run: () => T | Promise<T>,
): Promise<T> {
  const descriptor = openSync(path, "a");
  try {
    const deadline = Date.now() + LOCK_WAIT;
    while (!flock(descriptor, LOCK_EX | LOCK_NB)) {
      if (Date.now() > deadline)
        throw new Error(`${label} stayed locked for ${LOCK_WAIT / 1000} s: ${path}`);

      await Bun.sleep(5 + Math.random() * 15);
    }

    return await run();
  } finally {
    closeSync(descriptor);
  }
}

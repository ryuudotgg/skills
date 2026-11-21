import { closeSync, openSync } from "node:fs";
import { dlopen, FFIType } from "bun:ffi";

export const LOCK_WAIT = 10_000;
export const LOCK_POLL = 20;
const LOCK_EX = 2;
const LOCK_NB = 4;

let libc: { flock(descriptor: number, operation: number): number } | undefined;
function flock(descriptor: number, operation: number): boolean {
  libc ??= dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  }).symbols;

  return libc.flock(descriptor, operation) === 0;
}

export async function tryLock<T>(
  path: string,
  run: (descriptor: number) => T | Promise<T>,
): Promise<{ held: true } | { held: false; value: T }> {
  const descriptor = openSync(path, "a");
  try {
    if (!flock(descriptor, LOCK_EX | LOCK_NB)) return { held: true };
    return { held: false, value: await run(descriptor) };
  } finally {
    closeSync(descriptor);
  }
}

export async function withLock<T>(
  path: string,
  label: string,
  run: () => T | Promise<T>,
  wait = LOCK_WAIT,
): Promise<T> {
  const descriptor = openSync(path, "a");
  try {
    const deadline = Date.now() + wait;
    while (!flock(descriptor, LOCK_EX | LOCK_NB)) {
      if (Date.now() > deadline)
        throw new Error(`${label} stayed locked for ${wait / 1000} s: ${path}`);

      await Bun.sleep(5 + Math.random() * (LOCK_POLL - 5));
    }

    return await run();
  } finally {
    closeSync(descriptor);
  }
}

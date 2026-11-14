import { readFileSync } from "node:fs";
import { join, sep } from "node:path";
import {
  drainSpool,
  latestRevision,
  openStore,
  recordRevision,
  sha256,
  spoolRevision,
  write,
} from "../plans/store.ts";

const BUSY_MS = 100;

type Copy = { key: string; bytes: Uint8Array; digest: string };

function copiesOf(root: string, keys: readonly string[]): Copy[] {
  return keys.flatMap((key) => {
    try {
      const bytes = readFileSync(join(root, key));
      return [{ key, bytes, digest: sha256(bytes) }];
    } catch {
      return [];
    }
  });
}

function recorded(root: string, copies: readonly Copy[], captured: string): boolean {
  try {
    const store = openStore(join(root, "plans.db"), { busyMs: BUSY_MS, drain: false });
    try {
      if (!drainSpool(store, root)) return false;

      write(store, () => {
        for (const { key, bytes, digest } of copies)
          if (latestRevision(store, key) !== digest)
            recordRevision(store, key.split(sep)[0]!, key, bytes, digest, captured);
      });
    } finally {
      store.db.close();
    }

    return true;
  } catch {
    return false;
  }
}

export function recordCopies(root: string, keys: readonly string[]): void {
  const copies = copiesOf(root, keys);
  if (copies.length === 0) return;

  const captured = new Date().toISOString();
  if (recorded(root, copies, captured)) return;

  for (const { key, bytes } of copies)
    try {
      spoolRevision(root, key, bytes, captured);
    } catch {}
}

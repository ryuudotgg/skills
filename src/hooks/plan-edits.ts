import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { plansDir } from "../plans/index-tsv.ts";
import {
  latestRevision,
  openStore,
  recordRevision,
  sha256,
  spoolPending,
  spoolRevision,
  workingCopyKey,
  write,
} from "../plans/store.ts";
import { parsePayload } from "./payload.ts";

const BUSY_MS = 100;

type Copy = { key: string; bytes: Uint8Array; digest: string };

function editedCopies(payload: Record<string, unknown>, root: string): Copy[] {
  const keys = new Set(
    parsePayload(payload).paths.flatMap((path) => workingCopyKey(root, resolve(path)) ?? []),
  );

  return [...keys].flatMap((key) => {
    try {
      const bytes = readFileSync(join(root, key));
      return [{ key, bytes, digest: sha256(bytes) }];
    } catch {
      return [];
    }
  });
}

function recorded(root: string, copies: readonly Copy[], captured: string): boolean {
  if (spoolPending(root)) return false;

  try {
    const store = openStore(join(root, "plans.db"), { busyMs: BUSY_MS, drain: false });
    try {
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

export function recordPlanEdits(payload: Record<string, unknown>, env: NodeJS.ProcessEnv): void {
  try {
    const root = resolve(plansDir(env));
    const copies = editedCopies(payload, root);
    if (copies.length === 0) return;

    const captured = new Date().toISOString();
    if (recorded(root, copies, captured)) return;

    for (const { key, bytes } of copies)
      try {
        spoolRevision(root, key, bytes, captured);
      } catch {}
  } catch {}
}

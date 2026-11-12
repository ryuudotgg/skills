import { durationText } from "./time.ts";

export type SyncState =
  | { state: "local only" }
  | { state: "synced"; lastSync: string; queue: number; conflicts: number; reconciled?: string }
  | { state: "offline"; reason: string };

function count(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function instant(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function parseSync(text: string): SyncState {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null) throw new Error("not a sync state");

  const sync = value as Record<string, unknown>;
  if (sync.state === "local only") return { state: "local only" };

  if (sync.state === "offline" && typeof sync.reason === "string")
    return { state: "offline", reason: sync.reason };

  if (
    sync.state === "synced" &&
    instant(sync.lastSync) &&
    count(sync.queue) &&
    count(sync.conflicts) &&
    (sync.reconciled === undefined || instant(sync.reconciled))
  )
    return {
      state: "synced",
      lastSync: sync.lastSync,
      queue: sync.queue,
      conflicts: sync.conflicts,
      ...(sync.reconciled === undefined ? {} : { reconciled: sync.reconciled }),
    };

  throw new Error("not a sync state");
}

export function syncText(sync: SyncState, now: number): string {
  if (sync.state === "local only") return "local only";
  if (sync.state === "offline") return `offline: ${sync.reason}`;

  const age = durationText(Math.max(0, now - Date.parse(sync.lastSync)));
  const reconciled = sync.reconciled === undefined ? "" : `, reconciled ${sync.reconciled}`;
  return `synced ${age} ago, queue ${sync.queue}, conflicts ${sync.conflicts}${reconciled}`;
}

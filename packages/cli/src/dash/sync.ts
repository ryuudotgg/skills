import type { SyncState } from "skills-core";
import { hubSetting } from "../hub/network.ts";
import type { SyncOutcome } from "../hub/sync.ts";

export const SYNC_EVERY_MS = 5_000;

export type Attempt = (env: NodeJS.ProcessEnv) => Promise<SyncOutcome>;

export type SyncTask = { current(): SyncState | undefined; stop(): Promise<void> };

type Runner = { attempt: Attempt; close(): void };

const LOCAL: SyncState = { state: "local only" };

function inWorker(): Runner {
  let settle: ((outcome: SyncOutcome) => void) | undefined;

  return {
    attempt: (env) =>
      new Promise((resolve) => {
        const worker = new Worker(new URL("./sync-worker.ts", import.meta.url));
        settle = (outcome) => {
          settle = undefined;
          worker.terminate();
          resolve(outcome);
        };

        worker.onmessage = (event: MessageEvent<SyncOutcome>) => settle?.(event.data);
        worker.onerror = (event) => settle?.({ kind: "failed", message: event.message });
        worker.postMessage(env);
      }),
    close: () => settle?.({ kind: "failed", message: "skills dash stopped" }),
  };
}

function stateOf(outcome: SyncOutcome): SyncState | undefined {
  if (outcome.kind === "busy" || outcome.kind === "failed") return undefined;
  if (outcome.kind === "local") return LOCAL;
  if (outcome.kind === "offline") return { state: "offline", reason: outcome.reason };

  const { tally } = outcome;
  if (tally === undefined) return undefined;
  if (tally.lastSync === undefined) return { state: "offline", reason: "last sync never" };

  return {
    state: "synced",
    lastSync: tally.lastSync,
    queue: tally.queue,
    conflicts: tally.conflicts,
    ...(tally.reconciled === undefined ? {} : { reconciled: tally.reconciled }),
  };
}

export function startSync(
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void,
  every = SYNC_EVERY_MS,
  runner: () => Runner = inWorker,
): SyncTask {
  if (hubSetting(env, "HUB_URL") === undefined)
    return { current: () => LOCAL, stop: async () => {} };

  const { attempt, close } = runner();
  let latest: SyncState | undefined;
  let warned: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const loop = async (): Promise<void> => {
    const outcome = await attempt(env).catch((error: unknown): SyncOutcome => ({
      kind: "failed",
      message: String(error),
    }));

    if (stopped) return;
    if (outcome.kind === "failed" && outcome.message !== warned) warn(outcome.message);
    warned = outcome.kind === "failed" ? outcome.message : undefined;
    latest = stateOf(outcome) ?? latest;
    timer = setTimeout(() => (running = loop()), every);
  };

  let running = loop();

  return {
    current: () => latest,
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      close();
      await running;
    },
  };
}

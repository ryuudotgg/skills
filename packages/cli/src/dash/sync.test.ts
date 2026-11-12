import { expect, test } from "bun:test";
import type { SyncOutcome } from "../hub/sync.ts";
import { startSync, type Attempt } from "./sync.ts";

const HUB = { HUB_URL: "http://127.0.0.1:9", SKILLS_CONF: "/nonexistent" };

const quiet = () => {};

function runner(attempt: Attempt) {
  return () => ({ attempt, close: () => {} });
}

function attempts(outcomes: SyncOutcome[]) {
  const calls: NodeJS.ProcessEnv[] = [];
  let settle = () => {};
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const attempt = async (env: NodeJS.ProcessEnv): Promise<SyncOutcome> => {
    calls.push(env);
    const next = outcomes.shift();
    if (outcomes.length === 0) settle();
    return next ?? { kind: "busy" };
  };

  return { calls, done, attempt };
}

const tally = {
  lastSync: "2026-11-06T12:00:00.000Z",
  queue: 0,
  conflicts: 0,
  reconciled: undefined,
};

const synced: SyncOutcome = { kind: "synced", tally };

async function settled(task: ReturnType<typeof startSync>): Promise<void> {
  for (let waited = 0; task.current() === undefined && waited < 5_000; waited += 5)
    await Bun.sleep(5);
}

test("with no hub the task is local only and never runs a sync", async () => {
  const run = attempts([synced]);
  const task = startSync({ SKILLS_CONF: "/nonexistent" }, quiet, 0, runner(run.attempt));
  await Bun.sleep(20);
  await task.stop();

  expect(task.current()).toEqual({ state: "local only" });
  expect(run.calls).toHaveLength(0);
});

test("with a hub the task has no state until the first sync, keeps it while busy or failed, then follows", async () => {
  const run = attempts([
    { kind: "busy" },
    synced,
    { kind: "failed", message: "database is locked" },
    { kind: "offline", reason: "the hub does not answer" },
  ]);

  const seen: unknown[] = [];
  const warned: string[] = [];
  const task = startSync(
    HUB,
    (message) => warned.push(message),
    0,
    runner(async (given) => {
      const outcome = await run.attempt(given);
      seen.push(task.current());
      return outcome;
    }),
  );

  await run.done;
  await Bun.sleep(5);
  await task.stop();

  const state = { state: "synced", lastSync: "2026-11-06T12:00:00.000Z", queue: 0, conflicts: 0 };
  expect(run.calls[0]).toBe(HUB);
  expect(seen.slice(0, 4)).toEqual([undefined, undefined, state, state]);
  expect(task.current()).toEqual({ state: "offline", reason: "the hub does not answer" });
  expect(warned).toEqual(["database is locked"]);
});

test("a failure repeated tick after tick is warned once, and again after a recovery", async () => {
  const failed: SyncOutcome = { kind: "failed", message: "disk I/O error" };
  const run = attempts([failed, failed, failed, synced, failed]);
  const warned: string[] = [];
  const task = startSync(HUB, (message) => warned.push(message), 0, runner(run.attempt));

  await run.done;
  await Bun.sleep(5);
  await task.stop();

  expect(warned).toEqual(["disk I/O error", "disk I/O error"]);
});

test("a reconciled time rides along, and a store that never synced reads last sync never", async () => {
  const run = attempts([
    {
      kind: "synced",
      tally: { ...tally, queue: 2, conflicts: 1, reconciled: "2026-11-05T09:00:00.000Z" },
    },
  ]);

  const task = startSync(HUB, quiet, 60_000, runner(run.attempt));
  await settled(task);
  await task.stop();

  expect(task.current()).toEqual({
    state: "synced",
    lastSync: "2026-11-06T12:00:00.000Z",
    queue: 2,
    conflicts: 1,
    reconciled: "2026-11-05T09:00:00.000Z",
  });

  const never = startSync(
    HUB,
    quiet,
    60_000,
    runner(async () => ({ kind: "synced", tally: { ...tally, lastSync: undefined } })),
  );

  await settled(never);
  await never.stop();
  expect(never.current()).toEqual({ state: "offline", reason: "last sync never" });
});

test("stop ends the loop and closes the runner: no sync starts after it", async () => {
  let calls = 0;
  let closed = 0;
  const task = startSync(HUB, quiet, 10, () => ({
    attempt: async () => {
      calls++;
      return synced;
    },
    close: () => closed++,
  }));

  await Bun.sleep(25);
  await task.stop();
  const stoppedAt = calls;
  await Bun.sleep(40);

  expect(stoppedAt).toBeGreaterThan(0);
  expect(calls).toBe(stoppedAt);
  expect(closed).toBe(1);
});

test("stop closes the runner without waiting for an attempt that never ends, and warns nothing", async () => {
  let end: ((outcome: SyncOutcome) => void) | undefined;
  const warned: string[] = [];
  const task = startSync(
    HUB,
    (message) => warned.push(message),
    60_000,
    () => ({
      attempt: () =>
        new Promise((resolve) => {
          end = resolve;
        }),
      close: () => end?.({ kind: "failed", message: "skills dash stopped" }),
    }),
  );

  await Bun.sleep(5);
  await task.stop();
  expect(task.current()).toBeUndefined();
  expect(warned).toEqual([]);
});

test("the default runner syncs in a fresh worker each tick: with no store it reads not enrolled", async () => {
  const task = startSync({ ...HUB, PLANS_DIR: "/nonexistent/plans" }, quiet, 10);
  await settled(task);
  await Bun.sleep(300);
  await task.stop();

  expect(task.current()).toEqual({ state: "offline", reason: "not enrolled" });
});

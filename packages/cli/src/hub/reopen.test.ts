import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { retriedUnder, unopenedEvents } from "../plans/outbox.ts";
import { applyRemoteEvents, type AuthoredEvent, type Verifier } from "../plans/sync.ts";
import { chained, trusting } from "../test/authored.ts";
import { machine, runCleanup, type Machine } from "../test/hub-machines.ts";
import { retryUnopened } from "./reopen.ts";
import { BATCH, Budget, Spent, type Run } from "./run.ts";
import { emptyReport } from "./sync.ts";

afterEach(runCleanup);

const BLIND: Verifier = { open: async () => undefined, cutoff: () => undefined };

const UNDER = { length: 3, epoch: 1 };

type Clock = { now: number };

function runOf(m: Machine, clock: Clock): Run {
  const budget = new Budget(1_000, { now: () => clock.now });
  return { deps: m.deps, root: m.root, budget, report: emptyReport() } as Run;
}

async function unopened(events: readonly AuthoredEvent[]): Promise<Machine> {
  const m = await machine({ "Skills/001-one.md": "# 001 one\n" });
  await applyRemoteEvents(m.root, { events, blobs: [] }, BLIND);
  return m;
}

function counting(clock: Clock): Verifier & { opened: number } {
  return {
    ...trusting,
    opened: 0,
    async open(event) {
      if (++this.opened === BATCH) clock.now += 2_000;
      return trusting.open(event);
    },
  };
}

function plans(count: number): string[] {
  return Array.from({ length: count }, (_, index) => String(100 + index));
}

function trail(m: Machine): string {
  return readFileSync(join(m.root, "log.tsv"), "utf8");
}

test("a retry that runs out of time keeps what it folded and finishes on the next sync", async () => {
  const m = await unopened(chained(crypto.randomUUID(), plans(BATCH + 1)));
  const clock = { now: 0 };

  await expect(retryUnopened(runOf(m, clock), counting(clock), UNDER)).rejects.toBeInstanceOf(
    Spent,
  );

  expect(unopenedEvents(m.store, 0, BATCH)).toHaveLength(1);
  expect(retriedUnder(m.store)?.after).toBeGreaterThan(0);
  expect(trail(m)).toContain("feat/100");

  await retryUnopened(runOf(m, clock), trusting, UNDER);
  expect(unopenedEvents(m.store, 0, BATCH)).toHaveLength(0);
  expect(retriedUnder(m.store)).toEqual(UNDER);
  expect(trail(m)).toContain(`feat/${100 + BATCH}`);
});

test("a retry cut short resumes past the events that still do not open", async () => {
  const forged = chained(crypto.randomUUID(), plans(BATCH)).map((event) => ({
    ...event,
    signature: new Uint8Array(32),
  }));

  const m = await unopened(forged);
  await applyRemoteEvents(
    m.root,
    { events: chained(crypto.randomUUID(), ["900"]), blobs: [] },
    BLIND,
  );

  const clock = { now: 0 };
  await expect(retryUnopened(runOf(m, clock), counting(clock), UNDER)).rejects.toBeInstanceOf(
    Spent,
  );

  expect(trail(m)).not.toContain("feat/900");

  const resumed = counting(clock);
  await retryUnopened(runOf(m, clock), resumed, UNDER);

  expect(resumed.opened).toBe(1);
  expect(trail(m)).toContain("feat/900");
  expect(retriedUnder(m.store)).toEqual(UNDER);
  expect(unopenedEvents(m.store, 0, BATCH + 1)).toHaveLength(BATCH);

  const settled = counting(clock);
  await retryUnopened(runOf(m, clock), settled, UNDER);
  expect(settled.opened).toBe(0);

  const grown = counting(clock);
  await retryUnopened(runOf(m, clock), grown, { length: 4, epoch: 1 });
  expect(grown.opened).toBe(BATCH);
});

test("a retry that fails records nothing", async () => {
  const m = await unopened(chained(crypto.randomUUID(), ["100"]));
  const clock = { now: 0 };
  const failing: Verifier = {
    ...trusting,
    open: async () => {
      throw new Error("the store went away");
    },
  };

  await expect(retryUnopened(runOf(m, clock), failing, UNDER)).rejects.toThrow(
    "the store went away",
  );

  expect(retriedUnder(m.store)).toBeUndefined();

  await retryUnopened(runOf(m, clock), trusting, UNDER);
  expect(trail(m)).toContain("feat/100");
  expect(retriedUnder(m.store)).toEqual(UNDER);
});

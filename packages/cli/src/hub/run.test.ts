import { expect, test } from "bun:test";
import { Budget, Spent } from "./run.ts";

const TWO_MIB = 2 * 1024 * 1024;

test("on an advanced clock a first upload with no known rate learns no slack and spends the budget", async () => {
  let now = 0;
  const budget = new Budget(10_000, { now: () => now });

  await budget.timed({ bytes: 200_000, method: "PUT" }, async () => {
    now += 200;
  });

  expect(budget.measured).toBe(1_000);
  expect(budget.overrun).toBe(0);

  now = 10_000;
  expect(budget.fits(0)).toBe(true);

  now = 10_001;
  expect(budget.fits(0)).toBe(false);
  expect(() => budget.check()).toThrow(Spent);
  expect(budget.spent).toBe(true);
});

test("admission on a saved rate of 1 byte per ms refuses a 2 MiB body until a probe PUT is sampled", async () => {
  let now = 0;
  const budget = new Budget(10_000, { now: () => now, saved: { rate: 1, slack: 0 } });
  expect(budget.fits(TWO_MIB, 0)).toBe(false);

  await budget.timed({ bytes: 300, method: "POST" }, async () => {
    now += 300;
  });

  expect(budget.measured).toBeUndefined();
  expect(budget.fits(TWO_MIB, 0)).toBe(false);

  await budget.timed({ bytes: 1_400_000, method: "PUT", probe: true }, async () => {
    now += 650;
  });

  expect(budget.measured).toBe(4_000);
  expect(budget.fits(TWO_MIB, 0)).toBe(true);
  expect(budget.fits(40 * 1024 * 1024, 0)).toBe(false);
  expect(budget.spent).toBe(false);
});

test("admission refuses a probe as Spent once under 4,000 ms remain", async () => {
  let now = 0;
  const budget = new Budget(10_000, { now: () => now });
  const probe = { bytes: 1_400_000, method: "PUT", probe: true };

  now = 6_000;
  await budget.timed(probe, async () => {});
  expect(budget.spent).toBe(false);

  now = 6_001;
  await expect(budget.timed(probe, async () => {})).rejects.toThrow(Spent);
  expect(budget.spent).toBe(true);
});

function clocked(ms: number): {
  budget: Budget;
  send: (bytes: number, method: string, took: number) => Promise<void>;
} {
  let now = 0;
  const budget = new Budget(ms, { now: () => now });
  const send = (bytes: number, method: string, took: number) =>
    budget.timed({ bytes, method }, async () => {
      now += took;
    });

  return { budget, send };
}

test("an inconclusive PUT after a slow small POST sets only its lower bound", async () => {
  const { budget, send } = clocked(30_000);
  await send(300, "POST", 1_000);
  await send(80_000, "PUT", 500);

  expect(budget.measured).toBeUndefined();
  expect(budget.bandwidth).toBe(160);
  expect(budget.fits(16 * 1024 * 1024)).toBe(false);
});

test("an inconclusive PUT as long as the floor sets no rate above its lower bound", async () => {
  const { budget, send } = clocked(30_000);
  await send(300, "POST", 387);
  await send(87_500, "PUT", 387);

  expect(budget.measured).toBeUndefined();
  expect(budget.bandwidth).toBeLessThan(227);
});

test("an inconclusive PUT leaves the rate of a conclusive burst before it", async () => {
  let now = 0;
  const budget = new Budget(30_000, { now: () => now });
  await budget.timed({ bytes: 300, method: "POST" }, async () => {
    now += 300;
  });

  const gate = Promise.withResolvers<void>();
  const put = { bytes: 700_000, method: "PUT" };
  const burst = Promise.all([
    budget.timed(put, () => gate.promise),
    budget.timed(put, () => gate.promise),
  ]);

  now += 650;
  gate.resolve();
  await burst;

  expect(budget.measured).toBe(4_000);

  await budget.timed({ bytes: 80_000, method: "PUT" }, async () => {
    now += 310;
  });

  expect(budget.measured).toBe(4_000);
});

test("a rate carries what fits in the time left after the round trip and the slack", async () => {
  let now = 0;
  const budget = new Budget(2_000, { now: () => now });

  await budget.timed({ bytes: 300, method: "POST" }, async () => {
    now += 100;
  });

  expect(budget.roundTrip).toBe(100);
  expect(budget.carries(2)).toBe((2_000 - 100 - 100 - 100) * 2);

  now = 1_500;
  expect(budget.carries(2)).toBe((500 - 100 - 100) * 2);

  now = 1_900;
  expect(budget.carries(2)).toBe(0);
});

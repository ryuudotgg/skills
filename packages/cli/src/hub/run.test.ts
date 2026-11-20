import { expect, test } from "bun:test";
import { Budget, Spent } from "./run.ts";

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

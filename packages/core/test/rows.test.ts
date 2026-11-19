import { expect, test } from "bun:test";
import { isClosed, STATUSES } from "skills-core";

test("isClosed holds for DONE and DROPPED only", () => {
  const closed = STATUSES.filter((status) => isClosed(status));

  expect(closed).toEqual(["DONE", "DROPPED"]);
  expect(isClosed("")).toBe(false);
  expect(isClosed("done")).toBe(false);
  expect(isClosed("MERGED")).toBe(false);
});

import { expect, test } from "bun:test";
import { moveRefusal, movesIn, movingMark, type Moved, type PlanEvent } from "../src/index.ts";

const moved: Moved = {
  sha256: "a".repeat(64),
  size: 10_240,
  source: "device-a",
  to: "B",
  toDevice: "device-b",
  head: "1".repeat(40),
  base: "2".repeat(40),
  blobs: [],
};

function event(type: string, wall: number, payload: unknown = {}): PlanEvent {
  const placed = {
    machine: "m",
    wall,
    counter: 0,
    ts: "2026-11-11T00:00:00Z",
    project: "Demo",
    plan: "001",
  };

  return type === "start"
    ? { ...placed, kind: "trail", type, legacy: false, detail: "feat/move", line: "" }
    : { ...placed, kind: "stored", id: `e${wall}`, type, payload };
}

test("a plan is moving from its newest moved event until a later start", () => {
  const before = [event("start", 1), event("moved", 2, moved)];
  expect(movesIn(before).get("001")).toEqual(moved);
  expect(movesIn([...before, event("heartbeat", 3)]).get("001")).toEqual(moved);

  expect(movesIn([...before, event("lease", 3)]).get("001")).toEqual(moved);
  expect(movesIn([...before, event("start", 3)]).has("001")).toBe(false);
  expect(movesIn([...before, event("adopted", 3)]).has("001")).toBe(false);
  expect(movesIn([event("moved", 2, { ...moved, sha256: "" })]).has("001")).toBe(false);
});

test("start refuses everywhere but the named target, and nowhere for a move to any machine", () => {
  expect(moveRefusal("001", moved, "device-a")).toBe("001 is moving to B");
  expect(moveRefusal("001", moved, undefined)).toBe("001 is moving to B");
  expect(moveRefusal("001", moved, "device-b")).toBeUndefined();
  expect(moveRefusal("001", { ...moved, to: null, toDevice: null }, "device-a")).toBeUndefined();
  expect(movingMark({ ...moved, to: null, toDevice: null })).toBe("(moving to any)");
});

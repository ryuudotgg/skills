import { expect, test } from "bun:test";
import { feedLines, mergeFeed, parseFeed, sceneAt, type FeedEvent } from "skills-core";

function event(id: string, wall: number, machine = "studio"): FeedEvent {
  return {
    id,
    machine,
    wall,
    counter: 0,
    ts: new Date(wall).toISOString(),
    project: "Alpha",
    plan: "001",
    type: "start",
    legacy: false,
    payload: { detail: "check", line: "" },
  };
}

test("feed lines round trip through parseFeed", () => {
  const events = [event("a", 1), event("b", 2)];
  expect(parseFeed(feedLines(events))).toEqual(events);
});

test("parseFeed names the first line that is not an event", () => {
  expect(() => parseFeed(`${feedLines([event("a", 1)])}{"id":"b"}\n`)).toThrow(
    "feed line 2 is not an event",
  );
});

test("an event that arrives after the cursor with an older wall merges into its place", () => {
  const held = mergeFeed([], [event("a", 10), event("c", 30)]);
  const merged = mergeFeed(held, [event("b", 20, "laptop")]);
  expect(merged.map((each) => each.id)).toEqual(["a", "b", "c"]);
});

test("merging an event the tab already holds returns the same array", () => {
  const held = mergeFeed([], [event("a", 10), event("b", 20)]);
  expect(mergeFeed(held, [event("b", 20), event("b", 20)])).toBe(held);
});

test("parseFeed refuses a line core cannot decode", () => {
  const broken = { ...event("a", 1), type: "row", payload: {} };
  expect(() => parseFeed(`${JSON.stringify(broken)}\n`)).toThrow("feed line 1: event row");
});

test("sceneAt keeps events at or before the cut and makes the cut now", () => {
  const events = [event("a", 10), event("b", 20), event("c", 30)];

  const cut = sceneAt(events, 20, 99);
  expect(cut.now).toBe(20);
  expect(cut.events.map((each) => each.wall)).toEqual([10, 20]);

  const live = sceneAt(events, undefined, 99);
  expect(live.now).toBe(99);
  expect(live.events).toHaveLength(3);
});

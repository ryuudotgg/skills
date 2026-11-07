import { expect, test } from "bun:test";
import {
  compareEvents,
  eventFrom,
  foldRows,
  historyOf,
  isTrailVerb,
  recordOf,
  renderIndex,
  renderTrail,
  tick,
  trailEntry,
  trailOf,
  type EventRecord,
  type IndexRow,
} from "skills-core";

const stamp = { wall: 1, counter: 0, machine: "m" };
function record(type: string, plan: string, legacy: boolean, payload: unknown): EventRecord {
  return { ...stamp, ts: "2026-11-07T00:00:00Z", project: "Skills", plan, type, legacy, payload };
}

function row(id: string, slug: string, note: string): IndexRow {
  return {
    id,
    slug,
    status: "TODO",
    pri: "P1",
    effort: "S",
    blocked_by: "-",
    ctx: "-",
    branch: "-",
    updated: "2026-11-07",
    note,
  };
}

const trailPayload = { detail: "d", line: "line" };

test("the clock advances to a later physical time and counts within a wall time", () => {
  expect(tick({ wall: 10, counter: 3 }, 20)).toEqual({ wall: 20, counter: 0 });
  expect(tick({ wall: 10, counter: 3 }, 5)).toEqual({ wall: 10, counter: 4 });
  expect(tick({ wall: 10, counter: 3 }, Number.NaN)).toEqual({ wall: 10, counter: 4 });
});

test("events order by wall, then counter, then machine by code unit", () => {
  const events = [
    { wall: 2, counter: 0, machine: "a" },
    { wall: 1, counter: 1, machine: "a" },
    { wall: 1, counter: 1, machine: "B" },
    { wall: 1, counter: 0, machine: "z" },
  ];

  expect([...events].sort(compareEvents)).toEqual([
    { wall: 1, counter: 0, machine: "z" },
    { wall: 1, counter: 1, machine: "B" },
    { wall: 1, counter: 1, machine: "a" },
    { wall: 2, counter: 0, machine: "a" },
  ]);
});

test.each([
  ["start", "001", false, "trail"],
  ["conflict-sent", "001", false, "trail"],
  ["start", "-", false, "trail"],
  ["nudge", "-", false, "trail"],
  ["handover", "001", true, "trail"],
  ["review", "-", true, "trail"],
  ["row", "002", true, "trail"],
  ["row", "001", false, "row"],
  ["added", "001", false, "row"],
  ["imported", "001", false, "row"],
] as const)("%s on plan %s with legacy %s reads as a %s event", (type, plan, legacy, kind) => {
  const payload = kind === "row" ? { row: row(plan, "slug", "") } : trailPayload;
  expect(eventFrom(record(type, plan, legacy, payload)).kind).toBe(kind);
});

test("a verb this release does not know keeps its recorded line, and anything else is stored", () => {
  expect(eventFrom(record("merged", "001", false, trailPayload)).kind).toBe("trail");
  expect(eventFrom(record("synced", "001", false, { cursor: 4 })).kind).toBe("stored");
});

test("a recorded event reads back as the event that was written", () => {
  const stamp = { wall: 5, counter: 2, machine: "m" };
  const entry = trailEntry({ ts: "t", project: "Skills", id: "-", event: "review", detail: "x" });
  const added = recordOf({
    kind: "row",
    type: "added",
    at: 0,
    project: "Skills",
    row: row("001", "one", "n"),
  });

  const logged = recordOf({ kind: "trail", at: 0, entry });

  expect(eventFrom({ ...stamp, ...added })).toEqual({
    ...stamp,
    ts: "1970-01-01T00:00:00Z",
    project: "Skills",
    plan: "001",
    kind: "row",
    type: "added",
    row: row("001", "one", "n"),
  });

  expect(logged.legacy).toBe(true);
  expect(trailOf([eventFrom({ ...stamp, ...logged })])).toEqual([entry]);
});

test("a trail line is legacy exactly when its verb is outside the set for its plan id", () => {
  expect(isTrailVerb("wave", "001")).toBe(true);
  expect(isTrailVerb("wave", "-")).toBe(false);
  expect(isTrailVerb("handover", "001")).toBe(false);
  expect(isTrailVerb("row", "001")).toBe(false);
});

test("a malformed row or trail payload is refused, naming the event", () => {
  expect(() => eventFrom(record("row", "001", false, { line: "x" }))).toThrow(
    "event row for Skills 001 at 2026-11-07T00:00:00Z has no row",
  );

  expect(() => eventFrom(record("start", "001", false, { detail: "d" }))).toThrow(
    "has no detail and line",
  );
});

test("rows fold last write wins in first appearance order, flattened, ignoring other events", () => {
  const events = [
    record("added", "001", false, { row: row("001", "one", "first") }),
    record("start", "001", false, trailPayload),
    record("added", "002", false, { row: row("002", "two", "a\tb") }),
    record("row", "001", false, { row: row("001", "one", "second") }),
    record("handover", "001", false, { anything: true }),
  ].map(eventFrom);

  const rows = [...(foldRows(events).get("Skills")?.values() ?? [])];

  expect(rows.map((entry) => [entry.id, entry.note])).toEqual([
    ["001", "second"],
    ["002", "a b"],
  ]);

  expect(renderIndex(rows).split("\n")[2]).toBe("002\ttwo\tTODO\tP1\tS\t-\t-\t-\t2026-11-07\ta b");
});

test("the trail render prints trail and legacy lines verbatim and never a row or stored event", () => {
  const short = "2026-10-31T09:00:00Z\tSkills\t001\tstart";
  const events = [
    record("start", "001", false, { detail: "", line: short }),
    record("row", "001", false, { row: row("001", "one", "") }),
    record("handover", "001", true, { detail: "old", line: "legacy line" }),
    record("synced", "001", false, { cursor: 4 }),
  ].map(eventFrom);

  expect(renderTrail(trailOf(events))).toBe(
    `ts\tproject\tid\tevent\tdetail\n${short}\nlegacy line\n`,
  );
});

test("a logged entry flattens every field and joins the line from them", () => {
  expect(
    trailEntry({ ts: "t", project: "Ski\tlls", id: "001", event: "start", detail: "a\nb" }),
  ).toEqual({
    ts: "t",
    project: "Ski lls",
    id: "001",
    event: "start",
    detail: "a b",
    line: "t\tSki lls\t001\tstart\ta b",
  });
});

test("a plan's history folds every entry it is given, the ad hoc id included", () => {
  const history = historyOf([
    { event: "start", ts: "2026-11-07T00:00:00Z", detail: "feat/x" },
    { event: "thread", ts: "2026-11-07T00:00:01Z", detail: "t1" },
    { event: "conflict-sent", ts: "2026-11-07T00:00:02Z", detail: "abc" },
  ]);

  expect(history).toEqual({
    start: Date.parse("2026-11-07T00:00:00Z"),
    live: true,
    thread: "t1",
    sent: new Set(["abc"]),
  });
});

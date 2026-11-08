import { expect, test } from "bun:test";
import {
  eventFrom,
  foldIssues,
  recordOf,
  trailOf,
  type EventDraft,
  type PlanEvent,
} from "skills-core";

let wall = 0;
function stored(draft: EventDraft): PlanEvent {
  wall += 1;
  return eventFrom({ ...recordOf(draft), wall, counter: 0, machine: "m" });
}

function filed(project: string, n: number, title: string, at = 1000): PlanEvent {
  return stored({
    kind: "stored",
    type: "issue",
    at,
    project,
    plan: `#${n}`,
    payload: { n, title, body: null, from: null },
  });
}

function closed(project: string, n: number, reason: string, at = 2000): PlanEvent {
  return stored({
    kind: "stored",
    type: "issue-closed",
    at,
    project,
    plan: `#${n}`,
    payload: { reason, resolvedBy: [] },
  });
}

test("issue events are stored events, never trail lines", () => {
  const events = [filed("Beta", 1, "One"), closed("Beta", 1, "done")];
  expect(events.map((event) => event.kind)).toEqual(["stored", "stored"]);
  expect(trailOf(events)).toEqual([]);
});

test("the fold keeps the first filing per number and the first close, sorted by ref", () => {
  const issues = foldIssues([
    filed("Beta", 2, "Two"),
    filed("Alpha", 1, "Alpha one"),
    filed("Beta", 1, "One"),
    filed("Beta", 1, "Duplicate"),
    closed("Beta", 1, "first", 5000),
    closed("Beta", 1, "second", 6000),
    closed("Beta", 9, "no such issue"),
  ]);

  expect(issues.map((issue) => [issue.project, issue.n, issue.title, issue.state])).toEqual([
    ["Alpha", 1, "Alpha one", { kind: "open" }],
    ["Beta", 1, "One", { kind: "closed", reason: "first", at: "1970-01-01T00:00:05Z" }],
    ["Beta", 2, "Two", { kind: "open" }],
  ]);
});

test("the fold skips a payload that does not parse or sits under another number", () => {
  const malformed = stored({
    kind: "stored",
    type: "issue",
    at: 1000,
    project: "Beta",
    plan: "#3",
    payload: { n: 3, title: 7, body: null, from: null } as never,
  });

  expect(
    foldIssues(
      [malformed, filed("Beta", 4, "Misplaced")].map((event, index) =>
        index === 1 ? { ...event, plan: "#5" } : event,
      ),
    ),
  ).toEqual([]);
});

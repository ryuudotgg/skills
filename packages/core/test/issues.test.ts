import { expect, test } from "bun:test";
import {
  blockerState,
  eventFrom,
  foldIssues,
  inboxLines,
  issuesByRef,
  parseRef,
  recordOf,
  resolvers,
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

function linked(project: string, n: number, ref: string, kind: string): PlanEvent {
  return stored({
    kind: "stored",
    type: "issue-link",
    at: 1500,
    project,
    plan: `#${n}`,
    payload: { ref, kind } as never,
  });
}

test("links fold in order, unlinked drops only a resolves link, a repeat folds to one", () => {
  const [issue] = foldIssues([
    filed("Beta", 1, "One"),
    linked("Beta", 1, "Alpha/002", "blocks"),
    linked("Beta", 1, "Beta/003", "resolves"),
    linked("Beta", 1, "Beta/003", "resolves"),
    linked("Beta", 1, "Beta/004", "resolves"),
    linked("Beta", 1, "Alpha/002", "unlinked"),
    linked("Beta", 1, "Beta/004", "unlinked"),
    linked("Beta", 1, "Beta/005", "sideways"),
    linked("Beta", 9, "Beta/006", "resolves"),
  ]);

  expect(issue?.links).toEqual([
    { ref: "Alpha/002", kind: "blocks" },
    { ref: "Beta/003", kind: "resolves" },
  ]);

  expect(issue && resolvers(issue)).toEqual(["Beta/003"]);
  expect(trailOf([linked("Beta", 1, "Beta/003", "resolves")])).toEqual([]);
});

test("an issue ref is open, released once closed, or names no issue", () => {
  const issues = issuesByRef(
    foldIssues([filed("Beta", 1, "One"), filed("Beta", 2, "Two"), closed("Beta", 2, "done")]),
  );

  const world = { projects: new Map(), issues };
  const state = (text: string) => blockerState(parseRef(text), [], world);

  expect(state("Beta#1")).toEqual({ kind: "open", status: "open" });
  expect(state("Beta#2")).toEqual({ kind: "released", status: "closed" });
  expect(state("Beta#3")).toEqual({ kind: "no-issue" });
});

test("the inbox lists open issues only, and nothing when none is open", () => {
  const issues = foldIssues([
    filed("Beta", 1, "One"),
    filed("Beta", 2, "Two"),
    closed("Beta", 1, "done"),
  ]);

  expect(inboxLines(issues)).toEqual(["INBOX 1", "Beta#2 Two from -"]);
  expect(inboxLines(issues.slice(0, 1))).toEqual([]);
});

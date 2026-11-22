import { expect, test } from "bun:test";
import {
  blockerState,
  eventFrom,
  foldIssues,
  inboxLines,
  issueRef,
  issuesByRef,
  parseRef,
  recordOf,
  resolvers,
  trailOf,
  unreleasedReason,
  type EventDraft,
  type PlanEvent,
} from "skills-core";

let wall = 0;
function stored(draft: EventDraft): PlanEvent {
  wall += 1;
  return eventFrom({ ...recordOf(draft), id: `e${wall}`, wall, counter: 0, machine: "m" });
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

function closed(project: string, n: number, reason: string, at = 2000, filing?: string): PlanEvent {
  return stored({
    kind: "stored",
    type: "issue-closed",
    at,
    project,
    plan: `#${n}`,
    payload: { reason, resolvedBy: [], ...(filing && { filing }) },
  });
}

test("issue events are stored events, never trail lines", () => {
  const events = [filed("Beta", 1, "One"), closed("Beta", 1, "done")];
  expect(events.map((event) => event.kind)).toEqual(["stored", "stored"]);
  expect(trailOf(events)).toEqual([]);
});

test("the fold holds each number by its first filing and first close, sorted by ref", () => {
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

  expect(issues.map((issue) => issue.rivals.map((rival) => rival.title))).toEqual([
    [],
    ["Duplicate"],
    [],
  ]);
});

test("a number filed twice keeps both filings, a link or close with no filing on the first", () => {
  const issues = foldIssues([
    filed("Skills", 6, "first"),
    filed("Skills", 6, "second"),
    linked("Skills", 6, "Skills/002", "blocks"),
    closed("Skills", 6, "done", 5000),
  ]);

  expect(
    issues.map(({ title, state, links, rivals }) => ({ title, state, links, rivals })),
  ).toEqual([
    {
      title: "first",
      state: { kind: "closed", reason: "done", at: "1970-01-01T00:00:05Z" },
      links: [{ ref: "Skills/002", kind: "blocks" }],
      rivals: [
        {
          id: expect.any(String),
          n: 6,
          title: "second",
          body: null,
          from: null,
          filed: "1970-01-01T00:00:01Z",
          state: { kind: "open" },
          links: [],
        },
      ],
    },
  ]);

  expect(inboxLines(issues)).toEqual([
    "INBOX 1",
    "Skills#6 conflict: first | second, run skills issues renumber Skills#6",
  ]);
});

function idOf(event: PlanEvent): string {
  if (event.kind !== "stored") throw new Error("not a stored event");
  return event.id;
}

function renumbered(project: string, n: number, title: string, moved: string): PlanEvent {
  return stored({
    kind: "stored",
    type: "issue",
    at: 3000,
    project,
    plan: `#${n}`,
    payload: { n, title, body: null, from: null, moved },
  });
}

test("a link and a close stay on its own filing while rival and through its move", () => {
  const second = filed("Skills", 6, "second");
  const events = [
    filed("Skills", 6, "first"),
    second,
    linked("Skills", 6, "Skills/002", "blocks", idOf(second)),
    linked("Skills", 6, "Skills/003", "resolves"),
    closed("Skills", 6, "done", 5000, idOf(second)),
  ];

  const issues = foldIssues(events);
  expect(issues.map(({ title, state, links }) => ({ title, state, links }))).toEqual([
    { title: "first", state: { kind: "open" }, links: [{ ref: "Skills/003", kind: "resolves" }] },
  ]);

  expect(issues[0]?.rivals).toEqual([
    {
      id: idOf(second),
      n: 6,
      title: "second",
      body: null,
      from: null,
      filed: "1970-01-01T00:00:01Z",
      state: { kind: "closed", reason: "done", at: "1970-01-01T00:00:05Z" },
      links: [{ ref: "Skills/002", kind: "blocks" }],
    },
  ]);

  const ref = parseRef("Skills#6");
  const held = (folded: ReturnType<typeof foldIssues>) =>
    blockerState(ref, [], { projects: new Map(), issues: issuesByRef(folded) });

  expect(held(issues).kind).not.toBe("released");

  const bothClosed = held(foldIssues([...events, closed("Skills", 6, "also", 6000)]));
  expect(bothClosed.kind).not.toBe("released");
  expect(unreleasedReason(ref, bothClosed)).toBe(
    "blocker Skills#6 is filed more than once, run skills issues renumber Skills#6 first",
  );

  const moved = foldIssues([
    ...events,
    renumbered("Skills", 7, "second", idOf(second)),
    linked("Skills", 6, "Skills/004", "blocks", idOf(second)),
  ]);

  expect(
    moved.map((issue) => [issueRef(issue), issue.state.kind, issue.links, issue.rivals.length]),
  ).toEqual([
    ["Skills#6", "open", [{ ref: "Skills/003", kind: "resolves" }], 0],
    [
      "Skills#7",
      "closed",
      [
        { ref: "Skills/002", kind: "blocks" },
        { ref: "Skills/004", kind: "blocks" },
      ],
      0,
    ],
  ]);

  expect(held(moved)).toEqual({ kind: "open", status: "open" });
});

test("a link or close naming a filing the store does not show, or no id at all, folds nowhere", () => {
  const elsewhere = filed("Beta", 6, "elsewhere");
  const [issue] = foldIssues([
    elsewhere,
    filed("Skills", 6, "first"),
    linked("Skills", 6, "Skills/002", "blocks", "no-such-event"),
    linked("Skills", 6, "Skills/003", "blocks", idOf(elsewhere)),
    closed("Skills", 6, "done", 5000, "no-such-event"),
    linked("Skills", 6, "Skills/004", "blocks", 7 as never),
    closed("Skills", 6, "done", 6000, 7 as never),
  ]).filter((one) => one.project === "Skills");

  expect([issue?.state, issue?.links]).toEqual([{ kind: "open" }, []]);
});

test("a reference to a filing moved twice lands on its latest number", () => {
  const second = filed("Skills", 6, "second");
  const firstMove = renumbered("Skills", 7, "second", idOf(second));
  const issues = foldIssues([
    filed("Skills", 6, "first"),
    second,
    filed("Skills", 7, "seventh"),
    firstMove,
    renumbered("Skills", 8, "second", idOf(firstMove)),
    closed("Skills", 6, "done", 5000, idOf(second)),
  ]);

  expect(issues.map((issue) => [issueRef(issue), issue.state.kind, issue.rivals.length])).toEqual([
    ["Skills#6", "open", 0],
    ["Skills#7", "open", 0],
    ["Skills#8", "closed", 0],
  ]);
});

test("a row whose blocks link moved with its filing waits where the filing is now", () => {
  const first = filed("Skills", 6, "first");
  const second = filed("Skills", 6, "second");
  const move = renumbered("Skills", 7, "second", idOf(second));
  const late = linked("Skills", 6, "Skills/003", "blocks", idOf(second));
  const ref = parseRef("Skills#6");
  const state = (events: PlanEvent[], waiting?: string) =>
    blockerState(
      ref,
      [],
      { projects: new Map(), issues: issuesByRef(foldIssues(events)) },
      waiting,
    );

  for (const order of [
    [first, second, late, move, closed("Skills", 6, "done", 5000)],
    [first, second, move, late, closed("Skills", 6, "done", 5000)],
  ]) {
    const held = state(order, "Skills/003");

    expect(held).toEqual({ kind: "moved", to: "Skills#7", status: "open" });
    expect(unreleasedReason(ref, held)).toBe("blocker Skills#6 moved to Skills#7, which is open");
    expect(state(order).kind).toBe("released");
    expect(state(order, "Beta/003").kind).toBe("released");
  }

  const secondClosed = closed("Skills", 7, "fixed", 6000, idOf(second));
  expect(state([first, second, late, move, secondClosed], "Skills/003").kind).toBe("released");
  expect(state([first, second, late, move, secondClosed], "Skills/004")).toEqual({
    kind: "open",
    status: "open",
  });
});

test("a forward follows its filing through every later number", () => {
  const second = filed("Skills", 6, "second");
  const toSeven = renumbered("Skills", 7, "second", idOf(second));
  const events = [
    filed("Skills", 6, "first"),
    second,
    linked("Skills", 6, "Skills/003", "blocks", idOf(second)),
    filed("Skills", 7, "seventh"),
    toSeven,
    renumbered("Skills", 8, "second", idOf(toSeven)),
  ];

  const world = { projects: new Map(), issues: issuesByRef(foldIssues(events)) };
  for (const text of ["Skills#6", "Skills#7"])
    expect(blockerState(parseRef(text), [], world, "Skills/003")).toEqual({
      kind: "moved",
      to: "Skills#8",
      status: "open",
    });
});

test("a renumber moves its filing once, an unknown move files plainly", () => {
  const second = filed("Skills", 6, "second", 2000);
  const third = filed("Skills", 6, "third", 4000);
  const issues = foldIssues([
    filed("Skills", 6, "first"),
    second,
    third,
    renumbered("Skills", 7, "third", idOf(third)),
    renumbered("Skills", 9, "lost", "no-such-event"),
    renumbered("Beta", 1, "elsewhere", idOf(second)),
  ]);

  expect(
    issues.map((issue) => [issueRef(issue), issue.title, issue.filed, issue.rivals.length]),
  ).toEqual([
    ["Beta#1", "elsewhere", "1970-01-01T00:00:03Z", 0],
    ["Skills#6", "first", "1970-01-01T00:00:01Z", 1],
    ["Skills#7", "third", "1970-01-01T00:00:04Z", 0],
    ["Skills#9", "lost", "1970-01-01T00:00:03Z", 0],
  ]);

  expect(issues[1]?.rivals.map((rival) => rival.title)).toEqual(["second"]);
  expect(inboxLines(issues)[2]).toBe(
    "Skills#6 conflict: first | second, run skills issues renumber Skills#6",
  );
});

test("a repeat move takes its filing from where the earlier move left it", () => {
  const second = filed("Skills", 6, "second", 2000);
  const third = filed("Skills", 6, "third", 4000);
  const toSeven = renumbered("Skills", 7, "third", idOf(third));
  const before = [filed("Skills", 6, "first"), second, third, toSeven];
  const shape = (issues: ReturnType<typeof foldIssues>) =>
    issues.map((issue) => [
      issueRef(issue),
      issue.title,
      issue.filed,
      issue.state.kind,
      issue.rivals.map((rival) => rival.title),
    ]);

  const sixth = ["Skills#6", "first", "1970-01-01T00:00:01Z", "open", ["second"]];
  const moved = (n: number, state = "open") => [
    `Skills#${n}`,
    "third",
    "1970-01-01T00:00:04Z",
    state,
    [],
  ];

  expect(shape(foldIssues(before))).toEqual([sixth, moved(7)]);

  const toEight = renumbered("Skills", 8, "third", idOf(third));
  expect(shape(foldIssues([...before, toEight]))).toEqual([sixth, moved(8)]);

  for (const reference of [idOf(third), idOf(toSeven), idOf(toEight)])
    expect(
      shape(foldIssues([...before, toEight, closed("Skills", 7, "done", 5000, reference)])),
    ).toEqual([sixth, moved(8, "closed")]);

  const again = renumbered("Skills", 7, "third", idOf(third));
  expect(shape(foldIssues([...before, again]))).toEqual([sixth, moved(7)]);
});

test("a repeat move leaves the number it held to the next filing there", () => {
  const third = filed("Skills", 6, "third");
  const toSeven = renumbered("Skills", 7, "third", idOf(third));
  const issues = foldIssues([
    filed("Skills", 6, "first"),
    third,
    toSeven,
    filed("Skills", 7, "other"),
    linked("Skills", 7, "Skills/002", "blocks", idOf(toSeven)),
    renumbered("Skills", 8, "third", idOf(third)),
  ]);

  expect(
    issues.map((issue) => [
      issueRef(issue),
      issue.title,
      issue.links.map((link) => link.ref),
      issue.rivals.length,
    ]),
  ).toEqual([
    ["Skills#6", "first", [], 0],
    ["Skills#7", "other", [], 0],
    ["Skills#8", "third", ["Skills/002"], 0],
  ]);
});

test("a row waiting on the number a repeat move emptied waits where the filing is now", () => {
  const third = filed("Skills", 6, "third");
  const toEight = renumbered("Skills", 8, "third", idOf(third));
  const before = [filed("Skills", 6, "first"), third, filed("Skills", 7, "other"), toEight];
  const toSeven = renumbered("Skills", 7, "third", idOf(third));
  for (const events of [
    [...before, toSeven, linked("Skills", 8, "Skills/003", "blocks", idOf(toEight))],
    [...before, linked("Skills", 8, "Skills/003", "blocks"), toSeven],
  ]) {
    const world = { projects: new Map(), issues: issuesByRef(foldIssues(events)) };
    const state = (waiting: string) => blockerState(parseRef("Skills#8"), [], world, waiting);

    expect(world.issues.has("Skills#8")).toBe(false);
    expect(state("Skills/003")).toEqual({
      kind: "moved",
      to: "Skills#7",
      status: "filed more than once",
    });

    expect(state("Skills/004")).toEqual({ kind: "no-issue" });
  }
});

test("a move naming a number's holder files plainly, so a store missing the earlier filing keeps the state", () => {
  const first = filed("Skills", 6, "first");
  const second = filed("Skills", 6, "second");
  const later = [
    second,
    linked("Skills", 6, "Skills/002", "blocks"),
    closed("Skills", 6, "done", 5000),
    renumbered("Skills", 7, "second", idOf(second)),
  ];

  const shape = (issues: ReturnType<typeof foldIssues>) =>
    issues.map((issue) => [issue.n, issue.title, issue.state.kind, issue.links.length]);

  expect(shape(foldIssues(later))).toEqual([
    [6, "second", "closed", 1],
    [7, "second", "open", 0],
  ]);

  const full = foldIssues([first, ...later]);
  expect(shape(full)).toEqual([
    [6, "first", "closed", 1],
    [7, "second", "open", 0],
  ]);

  expect(full.map((issue) => issue.rivals)).toEqual([[], []]);
});

test("a moved filing that collides again moves under its new event id", () => {
  const fourth = filed("Skills", 7, "fourth");
  const third = filed("Skills", 6, "third");
  const moving = renumbered("Skills", 7, "third", idOf(third));
  const before = foldIssues([filed("Skills", 6, "first"), third, fourth, moving]);
  const rival = before[1]?.rivals[0];

  expect([before[1]?.title, rival?.title, rival?.id]).toEqual(["fourth", "third", idOf(moving)]);

  const after = foldIssues([
    filed("Skills", 6, "first"),
    third,
    fourth,
    moving,
    renumbered("Skills", 8, "third", rival?.id ?? ""),
  ]);

  expect(after.map((issue) => [issue.n, issue.title, issue.rivals.length])).toEqual([
    [6, "first", 0],
    [7, "fourth", 0],
    [8, "third", 0],
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

function linked(project: string, n: number, ref: string, kind: string, filing?: string): PlanEvent {
  return stored({
    kind: "stored",
    type: "issue-link",
    at: 1500,
    project,
    plan: `#${n}`,
    payload: { ref, kind, ...(filing && { filing }) } as never,
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

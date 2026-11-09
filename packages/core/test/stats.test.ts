import { expect, test } from "bun:test";
import { statsOf, type IndexRow, type PlanEvent, type StatsFilter } from "skills-core";

const HOUR = 3_600_000;

const NOW = Date.parse("2026-11-20T00:00:00Z");

const ALL: StatsFilter = { days: 30, project: undefined };

let counter = 0;
function placed(hours: number, project: string, plan: string, machine = "m1") {
  const wall = Date.parse("2026-11-10T00:00:00Z") + hours * HOUR;
  return { machine, wall, counter: counter++, ts: new Date(wall).toISOString(), project, plan };
}

function row(hours: number, id: string, status: string, type: "added" | "row" = "row"): PlanEvent {
  const fields: IndexRow = {
    id,
    slug: `plan-${id}`,
    status,
    pri: "P1",
    effort: id === "009" ? "XL" : "S",
    blocked_by: "-",
    ctx: "-",
    branch: "-",
    updated: "2026-11-10",
    note: "-",
  };

  return { ...placed(hours, "Alpha", id), kind: "row", type, row: fields };
}

function trail(hours: number, id: string, verb: string, project = "Alpha"): PlanEvent {
  return {
    ...placed(hours, project, id),
    kind: "trail",
    type: verb,
    legacy: false,
    detail: "-",
    line: "-",
  };
}

function stored(
  hours: number,
  project: string,
  plan: string,
  type: string,
  payload: unknown,
  machine = "m1",
): PlanEvent {
  return { ...placed(hours, project, plan, machine), kind: "stored", type, payload };
}

function closed(id: string, verbs: [number, string][], status = "DONE"): PlanEvent[] {
  return [
    row(0, id, "TODO", "added"),
    ...verbs.map(([hours, verb]) => trail(hours, id, verb)),
    row(100, id, status),
    trail(100, id, "done"),
  ];
}

function snapshot(
  hours: number,
  project: string,
  plan: string,
  session: string,
  tokens: number,
): PlanEvent {
  return stored(hours, project, plan, "session-stats", {
    host: "claude",
    session,
    models: { opus: { effort: "-", in: tokens, out: 0 } },
    tools: {},
    records: 1,
    start: null,
    end: null,
    subagents: 0,
  });
}

function linked(hours: number, project: string, session: string, plans: string[]): PlanEvent {
  return stored(hours, project, plans[0] ?? "-", "session", {
    host: "claude",
    session,
    branch: "feat/x",
    plans,
    source: "scan",
    started: "2026-11-10T00:00:00Z",
  });
}

test("build sums each start to its handback, and review runs from the first handback to done", () => {
  const stats = statsOf(
    closed("001", [
      [1, "start"],
      [2, "start"],
      [5, "handback"],
      [10, "start"],
      [12, "handback"],
      [20, "review"],
      [30, "handback"],
    ]),
    NOW,
    ALL,
  );

  expect(stats.phases.queue).toEqual({ median: 1 * HOUR, count: 1 });
  expect(stats.phases.build).toEqual({ median: 6 * HOUR, count: 1 });
  expect(stats.phases.review).toEqual({ median: 95 * HOUR, count: 1 });
  expect(stats.efforts).toEqual([
    { project: "Alpha", id: "001", effort: "S", elapsed: 101 * HOUR },
  ]);
});

test("a start left open at done drops build, DROPPED keeps only queue, and no added drops queue", () => {
  const open = closed("001", [
    [1, "start"],
    [5, "handback"],
    [10, "start"],
  ]);

  const dropped = closed("002", [[3, "start"]], "DROPPED");
  const unadded = closed("003", [
    [2, "start"],
    [4, "handback"],
  ]).slice(1);

  const stats = statsOf([...open, ...dropped, ...unadded], NOW, ALL);

  expect(stats.phases.queue).toEqual({ median: 2 * HOUR, count: 2 });
  expect(stats.phases.build).toEqual({ median: 2 * HOUR, count: 1 });
  expect(stats.phases.review.count).toBe(2);
  expect(stats.efforts.map((mark) => mark.id)).toEqual(["003"]);
});

test("a plan reopened after done is not closed, and an unknown effort counts as unsized", () => {
  const reopened = [
    ...closed("001", [
      [1, "start"],
      [2, "handback"],
    ]),
    row(101, "001", "DOING"),
  ];

  const unsized = closed("009", [
    [1, "start"],
    [2, "handback"],
  ]);

  const stats = statsOf([...reopened, ...unsized], NOW, ALL);

  expect(stats.phases.build.count).toBe(1);
  expect(stats.efforts).toEqual([]);
  expect(stats.unsized).toBe(1);
});

test("one decision written for every plan on its branch counts once", () => {
  const decision = {
    pr: 4,
    branch: "feat/batch",
    head: "abc",
    outcomes: { coderabbit: "fixed" },
    verdict: "done",
  };

  const fanned = [
    stored(5, "Alpha", "001", "round", decision),
    stored(5, "Alpha", "002", "round", decision),
  ];

  const later = stored(6, "Alpha", "001", "round", decision);

  expect(statsOf(fanned, NOW, ALL).reviewers).toEqual([
    { reviewer: "coderabbit", fixed: 1, dismissed: 0 },
  ]);

  expect(statsOf([...fanned, later], NOW, ALL).reviewers[0]?.fixed).toBe(2);
});

test("a hook block naming a rule twice counts it once", () => {
  const block = stored(5, "Alpha", "001", "hook-block", {
    rules: ["reply-guard/dash", "reply-guard/dash"],
    host: "claude",
  });

  expect(statsOf([block], NOW, ALL).blocks).toEqual([{ name: "reply-guard/dash", value: 1 }]);
});

test("window tokens subtract the snapshot from before the window and follow every linked plan", () => {
  const events = [
    linked(-200, "Alpha", "s-1", ["001"]),
    snapshot(-200, "Alpha", "001", "s-1", 1000),
    linked(150, "Alpha", "s-1", ["002"]),
    snapshot(150, "-", "-", "s-1", 1500),
  ];

  const stats = statsOf(events, NOW, { days: 7, project: undefined });
  expect(stats.models).toEqual([{ name: "opus", value: 500 }]);
  expect(stats.plans).toEqual([
    { name: "Alpha 001", value: 500 },
    { name: "Alpha 002", value: 500 },
  ]);

  expect(statsOf(events, NOW, { days: 7, project: "Alpha" }).models).toEqual([
    { name: "opus", value: 500 },
  ]);
});

test("a session linked to a project under policy off adds no tokens", () => {
  const events = [
    stored(0, "Beta", "-", "policy", { policy: "off" }),
    linked(1, "Alpha", "s-1", ["001"]),
    linked(2, "Beta", "s-1", ["004"]),
    snapshot(3, "Alpha", "001", "s-1", 900),
  ];

  const stats = statsOf(events, NOW, ALL);
  expect(stats.models).toEqual([]);
  expect(stats.plans).toEqual([]);
});

test("phases and windows use the recorded time, not a store clock an import moved forward", () => {
  const late = Date.parse("2026-11-19T00:00:00Z");
  const imported = closed("001", [
    [1, "start"],
    [7, "handback"],
  ]).map((event) => (event.kind === "trail" ? { ...event, wall: late } : event));

  expect(statsOf(imported, NOW, ALL).phases.build).toEqual({ median: 6 * HOUR, count: 1 });

  const week = statsOf(imported, Date.parse("2026-11-22T00:00:00Z"), {
    days: 7,
    project: undefined,
  });

  expect(week.phases.build.count).toBe(0);
  expect(week.weeks.every((each) => each.closed === 0)).toBe(true);
});

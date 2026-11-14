import { expect, test } from "bun:test";
import {
  DIGEST_SECTIONS,
  digestFrom,
  digestOf,
  digestsOf,
  isoWeekSpan,
  statsOf,
  weekSpanOf,
  type IndexRow,
  type PlanEvent,
} from "skills-core";

let counter = 0;
function placed(at: string, project: string, plan: string) {
  const wall = Date.parse(at);
  return { machine: "m1", wall, counter: counter++, ts: at, project, plan };
}

function row(at: string, project: string, id: string, status: string): PlanEvent {
  const fields: IndexRow = {
    id,
    slug: `plan-${id}`,
    status,
    pri: "P1",
    effort: "S",
    blocked_by: "-",
    ctx: "-",
    branch: "-",
    updated: "2026-11-10",
    note: "-",
  };

  const type = status === "TODO" ? "added" : "row";
  return { ...placed(at, project, id), kind: "row", type, row: fields };
}

function trail(at: string, project: string, id: string, verb: string): PlanEvent {
  return {
    ...placed(at, project, id),
    kind: "trail",
    type: verb,
    legacy: false,
    detail: "-",
    line: "-",
  };
}

function stored(
  at: string,
  project: string,
  plan: string,
  type: string,
  payload: unknown,
): PlanEvent {
  return {
    ...placed(at, project, plan),
    kind: "stored",
    id: `${project}${plan}${at}`,
    type,
    payload,
  };
}

function sections(markdown: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const part of markdown.split(/^## /m).slice(1)) {
    const [title = "", ...body] = part.trim().split("\n");
    found.set(
      title,
      body.filter((line) => line !== ""),
    );
  }

  return found;
}

const none = () => undefined;

test("an ISO week runs from Monday 00:00 UTC to the next Monday, and its name parses back", () => {
  const sunday = isoWeekSpan(Date.parse("2026-11-08T23:59:59Z"));
  const monday = isoWeekSpan(Date.parse("2026-11-09T00:00:00Z"));

  expect(sunday).toEqual({
    week: "2026-W45",
    start: Date.parse("2026-11-02T00:00:00Z"),
    end: Date.parse("2026-11-09T00:00:00Z"),
  });

  expect(monday.week).toBe("2026-W46");
  expect(weekSpanOf("2026-W45")).toEqual(sunday);

  expect(weekSpanOf("2026-W01")?.start).toBe(Date.parse("2025-12-29T00:00:00Z"));
  expect(weekSpanOf("2026-W53")?.start).toBe(Date.parse("2026-12-28T00:00:00Z"));
  expect(weekSpanOf("2025-W53")).toBeUndefined();
  expect(digestFrom({ week: "2025-W53", markdown: "" })).toBeUndefined();
});

test("an empty week prints every section in order, each reading none but the phase lines", () => {
  const { week, markdown } = digestOf([], Date.parse("2026-11-10T00:00:00Z"), none);
  const found = sections(markdown);

  expect(week).toBe("2026-W46");
  expect([...found.keys()]).toEqual([...DIGEST_SECTIONS]);
  expect(found.get("Phase times")).toEqual([
    "- queue none, prior week none",
    "- build none, prior week none",
    "- review none, prior week none",
  ]);

  for (const title of DIGEST_SECTIONS.filter((name) => name !== "Phase times"))
    expect(found.get(title)).toEqual(["none"]);
});

test("closes and phases match /stats for the week, events after it are ignored, and the prior week is its own fold", () => {
  const events = [
    row("2026-11-01T09:00:00Z", "Alpha", "001", "TODO"),
    trail("2026-11-01T10:00:00Z", "Alpha", "001", "start"),
    trail("2026-11-01T12:00:00Z", "Alpha", "001", "handback"),
    trail("2026-11-01T20:00:00Z", "Alpha", "001", "done"),
    row("2026-11-01T20:00:00Z", "Alpha", "001", "DONE"),
    row("2026-11-02T09:00:00Z", "Alpha", "002", "TODO"),
    trail("2026-11-03T09:00:00Z", "Alpha", "002", "start"),
    trail("2026-11-03T13:00:00Z", "Alpha", "002", "handback"),
    trail("2026-11-08T23:59:59Z", "Alpha", "002", "done"),
    row("2026-11-08T23:59:59Z", "Alpha", "002", "DONE"),
    row("2026-11-09T00:00:00Z", "Alpha", "002", "DOING"),
  ];

  const at = Date.parse("2026-11-04T00:00:00Z");
  const found = sections(digestOf(events, at, none).markdown);
  const sunday = Date.parse("2026-11-08T23:59:59.999Z");
  const stats = statsOf(
    events.filter((event) => event.wall <= sunday),
    sunday,
    { days: 7, project: undefined },
  );

  expect(found.get("Closes")).toEqual(["- Alpha 002 plan-002"]);
  expect(stats.closed).toEqual([{ project: "Alpha", id: "002", status: "DONE" }]);
  expect(found.get("Phase times")).toEqual([
    "- queue 24 h over 1 plan, prior week 1 h over 1 plan",
    "- build 4 h over 1 plan, prior week 2 h over 1 plan",
    "- review 131 h over 1 plan, prior week 8 h over 1 plan",
  ]);

  expect(found.get("Slowest phase")).toEqual(["- review, median 131 h"]);
});

test("a project under policy off contributes nothing, in the digest or in /stats", () => {
  const events = [
    stored("2026-11-02T08:00:00Z", "Beta", "-", "policy", { policy: "off" }),
    row("2026-11-02T09:00:00Z", "Beta", "001", "TODO"),
    trail("2026-11-02T10:00:00Z", "Beta", "001", "start"),
    trail("2026-11-02T11:00:00Z", "Beta", "001", "handback"),
    trail("2026-11-02T12:00:00Z", "Beta", "001", "done"),
    row("2026-11-02T12:00:00Z", "Beta", "001", "DROPPED"),
    stored("2026-11-03T10:30:00Z", "Beta", "001", "hook-block", { rules: ["a/b", "a/b", "a/b"] }),
  ];

  const markdown = digestOf(events, Date.parse("2026-11-04T00:00:00Z"), none).markdown;
  const stats = statsOf(events, Date.parse("2026-11-08T23:59:59Z"), {
    days: 7,
    project: undefined,
  });

  expect(markdown).not.toContain("Beta");
  expect(stats.closed).toEqual([]);
  expect(stats.projects).toEqual([]);
});

test("came back lists more than two reviews after the first handback, lessons two or more or DROPPED", () => {
  const plan = (id: string, reviews: number) => [
    row("2026-11-02T09:00:00Z", "Alpha", id, "TODO"),
    trail("2026-11-02T10:00:00Z", "Alpha", id, "review"),
    trail("2026-11-02T11:00:00Z", "Alpha", id, "handback"),
    ...Array.from({ length: reviews }, (_, index) =>
      trail(`2026-11-0${3 + index}T10:00:00Z`, "Alpha", id, "review"),
    ),
  ];

  const revision = "a".repeat(64);
  const events = [
    ...plan("001", 3),
    ...plan("002", 2),
    ...plan("003", 0),
    row("2026-11-02T09:00:00Z", "Alpha", "004", "TODO"),
    stored("2026-11-03T08:00:00Z", "Alpha", "004", "revision", {
      path: "Alpha/004-plan-004.md",
      sha256: revision,
      captured: "2026-11-03T08:00:00Z",
      size: 10,
      blob: "x",
    }),
    trail("2026-11-03T09:00:00Z", "Alpha", "004", "start"),
    trail("2026-11-03T10:00:00Z", "Alpha", "004", "done"),
    row("2026-11-03T10:00:00Z", "Alpha", "004", "DROPPED"),
  ];

  const landed = (sha256: string) =>
    sha256 === revision ? "Branch feat/x, not merged yet." : undefined;

  const found = sections(digestOf(events, Date.parse("2026-11-04T00:00:00Z"), landed).markdown);

  expect(found.get("Came back from review")).toEqual(["- Alpha 001 plan-001"]);
  expect(found.get("Closes")).toEqual(["- Alpha 004 plan-004, dropped"]);
  expect(found.get("Lessons for /plans new")).toEqual([
    "- Alpha 001 plan-001: -",
    "- Alpha 002 plan-002: -",
    "- Alpha 004 plan-004: Branch feat/x, not merged yet.",
  ]);
});

test("recurring hook blocks need three blocks of one rule in the week", () => {
  const block = (at: string, rule: string) =>
    stored(at, "Alpha", "001", "hook-block", { rules: [rule], host: "claude" });

  const events = [
    block("2026-11-01T10:00:00Z", "reply-guard/dash"),
    block("2026-11-02T10:00:00Z", "reply-guard/dash"),
    block("2026-11-03T10:00:00Z", "reply-guard/dash"),
    block("2026-11-04T10:00:00Z", "reply-guard/dash"),
    block("2026-11-03T10:00:00Z", "commit-guard/commit-shape"),
    block("2026-11-04T10:00:00Z", "commit-guard/commit-shape"),
  ];

  const found = sections(digestOf(events, Date.parse("2026-11-04T12:00:00Z"), none).markdown);

  expect(found.get("Recurring hook blocks")).toEqual(["- reply-guard/dash 3 blocks"]);
});

test("tokens of a session linked to a project under policy off stay out, as on /stats", () => {
  const events = [
    stored("2026-11-02T08:00:00Z", "Beta", "-", "policy", { policy: "off" }),
    stored("2026-11-03T08:00:00Z", "Beta", "001", "session", {
      host: "claude",
      session: "s1",
      branch: "feat/x",
      plans: ["001"],
      source: "scan",
      started: "2026-11-03T08:00:00Z",
    }),
    stored("2026-11-03T09:00:00Z", "Alpha", "001", "session-stats", {
      host: "claude",
      session: "s1",
      models: { opus: { effort: "-", in: 1000, out: 0 } },
      tools: {},
      records: 1,
      start: null,
      end: null,
      subagents: 0,
    }),
  ];

  const found = sections(digestOf(events, Date.parse("2026-11-04T00:00:00Z"), none).markdown);

  expect(found.get("Token spend")).toEqual(["none"]);
});

test("the policy that counts is the one in force at the week's end", () => {
  const events = [
    stored("2026-11-01T08:00:00Z", "Beta", "-", "policy", { policy: "off" }),
    row("2026-11-02T09:00:00Z", "Beta", "001", "TODO"),
    trail("2026-11-02T12:00:00Z", "Beta", "001", "done"),
    row("2026-11-02T12:00:00Z", "Beta", "001", "DONE"),
    stored("2026-11-10T08:00:00Z", "Beta", "-", "policy", { policy: "full" }),
  ];

  const found = sections(digestOf(events, Date.parse("2026-11-04T00:00:00Z"), none).markdown);

  expect(found.get("Closes")).toEqual(["none"]);
});

test("a stored digest drops the lines of a project that went off after it was written", () => {
  const markdown = [
    "## Closes",
    "",
    "- Beta 001 sync",
    "- Alpha 001 shell",
    "",
    "## Came back from review",
    "",
    "- Beta 002 feed",
    "",
  ].join("\n");

  const events = [
    stored("2026-11-09T09:00:00Z", "-", "-", "digest", { week: "2026-W45", markdown }),
    stored("2026-11-10T09:00:00Z", "Beta", "-", "policy", { policy: "off" }),
  ];

  expect(digestsOf(events)).toEqual([
    {
      week: "2026-W45",
      markdown: "## Closes\n\n- Alpha 001 shell\n\n## Came back from review\n\nnone\n",
      ts: "2026-11-09T09:00:00Z",
      machine: "m1",
      final: true,
    },
  ]);
});

test("a regression prints its result first, with a nonzero exit and its grade after", () => {
  const run = (at: string, exit: number, verdict: "pass" | "fail", grade: string) =>
    stored(at, "-", "-", "eval", {
      case: "c",
      models: ["opus"],
      roster: "claude",
      exit,
      verdict,
      grade,
      duration: 1,
    });

  const events = [
    run("2026-11-02T10:00:00Z", 0, "pass", "PASS 3/3"),
    run("2026-11-03T10:00:00Z", 1, "pass", "PASS 3/3"),
  ];

  const found = sections(digestOf(events, Date.parse("2026-11-04T00:00:00Z"), none).markdown);

  expect(found.get("Eval regressions")).toEqual([
    "- c 2026-11-03T10:00:00Z fail, exit 1, PASS 3/3",
  ]);
});

test("withholding touches only plan lines of the off project, never a model, a phase or a longer name, digits included", () => {
  const markdown = [
    "## Closes",
    "",
    "- Alpha 001 shell",
    "- Alpha Tools 002 lint",
    "- Office 365 003 mail",
    "",
    "## Phase times",
    "",
    "- queue 1 h over 1 plan, prior week none",
    "",
    "## Token spend",
    "",
    "- opus 1000 tokens",
    "",
  ].join("\n");

  const events = [
    stored("2026-11-09T09:00:00Z", "-", "-", "digest", { week: "2026-W45", markdown }),
    stored("2026-11-01T09:00:00Z", "Alpha Tools", "-", "policy", { policy: "full" }),
    stored("2026-11-01T09:00:00Z", "Office 365", "-", "policy", { policy: "full" }),
    stored("2026-11-10T09:00:00Z", "Office", "-", "policy", { policy: "off" }),
    stored("2026-11-10T09:00:00Z", "Alpha", "-", "policy", { policy: "off" }),
    stored("2026-11-10T09:00:00Z", "opus", "-", "policy", { policy: "off" }),
    stored("2026-11-10T09:00:00Z", "queue", "-", "policy", { policy: "off" }),
  ];

  expect(digestsOf(events)[0]?.markdown).toBe(markdown.replace("- Alpha 001 shell\n", ""));
});

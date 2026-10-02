import { matchesSetting, readDeclarations } from "../reviewers/declaration.ts";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { facts, decide, type Facts } from "../../skills/macroscope/reviewer.ts";
import { fixture, response, success } from "./fixtures.ts";
import { macroscopeFixture, inputFor } from "./reviewer-fixtures.ts";
import { runRound } from "./round.ts";
import type { CheckRun, Comment, ReviewerInput } from "./types.ts";

const temporary: string[] = [];

for (const [name, args, expected] of [
  ["medium gate verdict", ["gate", "18"], "triage findings"],
  ["medium fixed outcome", ["decide", "18", "feat/topic", "macroscope=fixed"], "triage findings"],
  [
    "medium dismissed outcome",
    ["decide", "18", "feat/topic", "macroscope=dismissed"],
    "handback all-dismissed",
  ],
  ["low noncritical gate", ["gate", "18"], "done approved"],
  ["low critical gate", ["gate", "18", "critical=true"], "triage findings"],
] as const)
  test(`verdict ${name}`, async () => {
    const value = fixture(["macroscope"]);
    temporary.push(value.temporary);
    value.deps.env.REVIEW_NOW = "2026-09-30T14:30:00Z";
    const snapshot = macroscopeFixture(name.split(" ")[0]!);
    value.deps.gh = async (argv, deadline) => {
      value.calls.push({ command: "gh", args: argv, deadline });
      return success(response(snapshot.pr));
    };

    const result = await runRound(args, value.deps);

    expect(result.stdout.split("\n")[0]).toBe(`macroscope ${expected}`);
    expect(result.stderr).toBe("");
    expect(value.calls.filter((call) => call.command === "gh")).toHaveLength(1);
  });

test("medium facts differ", () => {
  expect(facts(inputFor("macroscope", macroscopeFixture("medium")))).toEqual({
    reviewed: true,
    reviews: 1,
    worst: "medium",
    unanswered: "medium",
    triggered: false,
    approval: "approved",
    fixesFrom: null,
  });
});

for (const [body, expected] of [
  ["é **Low**", "critical"],
  ["１ **Low**", "critical"],
  ["\u001c\u0085🟡 **mEdIuM**", "medium"],
  ["text **Low**", "critical"],
  ["🔵 **Low**", "low"],
] as const)
  test(`anchored Unicode severity ${body}`, () => {
    const snapshot = macroscopeFixture("medium");
    snapshot.pr.reviewThreads.nodes[0]!.comments.nodes[0]!.body = body;
    expect(facts(inputFor("macroscope", snapshot)).worst).toBe(expected);
  });

test("newest uses index on ties and missing starts sort first", () => {
  const snapshot = macroscopeFixture("clean");
  const contexts = snapshot.pr.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes;
  const approval = contexts[0] as CheckRun;
  contexts.push(
    { ...approval, conclusion: "NEUTRAL" },
    { ...approval, startedAt: null, checkSuite: null },
  );

  expect(facts(inputFor("macroscope", snapshot)).approval).toBe("not-approved");
});

test("approval pending cap compares seconds", () => {
  const snapshot = macroscopeFixture("approval-pending");
  const approval = snapshot.pr.commits.nodes[0]!.commit.statusCheckRollup!.contexts
    .nodes[0] as CheckRun;

  approval.startedAt = "2026-09-30T14:10:01Z";

  expect(facts(inputFor("macroscope", snapshot)).approval).toBe("pending");
  approval.startedAt = "2026-09-30T14:10:00Z";
  expect(facts(inputFor("macroscope", snapshot)).approval).toBe("none");
});

test("empty startedAt falls back to checkSuite", () => {
  const snapshot = macroscopeFixture("approval-pending");
  const approval = snapshot.pr.commits.nodes[0]!.commit.statusCheckRollup!.contexts
    .nodes[0] as CheckRun;

  approval.startedAt = "";
  approval.checkSuite = { createdAt: "2026-09-30T14:25:00Z" };

  expect(facts(inputFor("macroscope", snapshot)).approval).toBe("pending");
});

test("cannot parse PR review", () => {
  const input = inputFor("macroscope", macroscopeFixture("medium"));
  input.snapshot.pr.commits.nodes = [];
  expect(() => facts(input)).toThrow("cannot parse PR review");
});

for (const args of [
  ["gate", "x"],
  ["gate", "18", "macroscope=fixed"],
  ["decide", "18", "feat/topic", "macroscope=other"],
])
  test(`usage verdict ${args.join(" ")}`, async () => {
    const value = fixture(["macroscope"]);
    temporary.push(value.temporary);

    const result = await runRound(args, value.deps);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(value.calls).toHaveLength(0);
  });

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

const cases = [
  {
    name: "clean",
    expected: "done approved",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [],
    comments: [],
  },
  {
    name: "clean",
    expected: "done approved",
    now: "2026-09-30T14:30:00Z",
    critical: true,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [],
    comments: [],
  },
  {
    name: "not-approved",
    expected: "done clean not-approved",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [],
    comments: [],
  },
  {
    name: "not-approved",
    expected: "handback not-approved",
    now: "2026-09-30T14:30:00Z",
    critical: true,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [],
    comments: [],
  },
  {
    name: "not-approved-low",
    expected: "done clean not-approved",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [],
    comments: [],
  },
  {
    name: "not-approved-low",
    expected: "triage findings",
    now: "2026-09-30T14:30:00Z",
    critical: true,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [],
    comments: [],
  },
  {
    name: "approval-skipped",
    expected: "done clean",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [],
    comments: [],
  },
  {
    name: "approval-skipped",
    expected: "done clean",
    now: "2026-09-30T14:30:00Z",
    critical: true,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [],
    comments: [],
  },
  {
    name: "no-approval",
    expected: "done clean",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [],
    comments: [],
  },
  {
    name: "approval-pending",
    expected: "wait approval-pending",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [],
    comments: [],
  },
  {
    name: "medium",
    expected: "triage findings",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [],
    comments: [],
  },
  {
    name: "low",
    expected: "done approved",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [],
    comments: [],
  },
  {
    name: "low",
    expected: "triage findings",
    now: "2026-09-30T14:30:00Z",
    critical: true,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [],
    comments: [],
  },
  {
    name: "resolved",
    expected: "done approved",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [],
    comments: [],
  },
  {
    name: "no-severity",
    expected: "triage findings",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [],
    comments: [],
  },
  {
    name: "human-thread",
    expected: "done approved",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [],
    comments: [],
  },
  {
    name: "neutral",
    expected: "triage findings",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [],
    comments: [],
  },
  {
    name: "old-medium",
    expected: "triage findings",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [],
    comments: [],
  },
  {
    name: "budget",
    expected: "handback round-cap",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [],
    comments: [],
  },
  {
    name: "medium",
    expected: "handback all-dismissed",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: "dismissed",
    rereviews: "2",
    threshold: "medium",
    approval: [],
    comments: [],
  },
  {
    name: "unreviewed",
    expected: "rereview paused",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [],
    comments: [],
  },
  {
    name: "unreviewed-budget",
    expected: "unavailable paused",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [],
    comments: [],
  },
  {
    name: "skipped",
    expected: "rereview paused",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [],
    comments: [],
  },
  {
    name: "triggered",
    expected: "unavailable no-review",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [],
    comments: [],
  },
  {
    name: "triggered-answered",
    expected: "triage findings",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [],
    comments: [],
  },
  {
    name: "pending",
    expected: "wait check-pending",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [],
    comments: [],
  },
  {
    name: "full-threads",
    expected: "triage findings",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [],
    comments: [],
  },
  {
    name: "rerun",
    expected: "done approved",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [],
    comments: [],
  },
  {
    name: "full-contexts",
    expected: "done clean not-approved",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [["completed", "neutral", "2026-09-30T14:20:00Z"]],
    comments: [],
  },
  {
    name: "full-contexts",
    expected: "handback not-approved",
    now: "2026-09-30T14:30:00Z",
    critical: true,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [["completed", "neutral", "2026-09-30T14:20:00Z"]],
    comments: [],
  },
  {
    name: "context-page",
    expected: "done clean",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [["completed", "neutral", "2026-09-30T14:20:00Z"]],
    comments: [],
  },
  {
    name: "context-page",
    expected: "done clean",
    now: "2026-09-30T14:30:00Z",
    critical: true,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [["completed", "neutral", "2026-09-30T14:20:00Z"]],
    comments: [],
  },
  {
    name: "full-contexts",
    expected: "done clean",
    now: "2026-09-30T14:30:00Z",
    critical: true,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [],
    comments: [],
  },
  {
    name: "stale-visible",
    expected: "done approved",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [["completed", "success", "2026-09-30T14:20:00Z"]],
    comments: [],
  },
  {
    name: "full-contexts",
    expected: "done clean",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [["queued", null, null]],
    comments: [],
  },
  {
    name: "commit-page",
    expected: "rereview paused",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [["queued", null, null]],
    comments: [],
  },
  {
    name: "long-commits",
    expected: "unavailable paused",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [["queued", null, null]],
    comments: [],
  },
  {
    name: "noise-page",
    expected: "rereview paused",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [["queued", null, null]],
    comments: [],
  },
  {
    name: "buried-trigger",
    expected: "rereview paused",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [["queued", null, null]],
    comments: ["noise"],
  },
  {
    name: "buried-trigger",
    expected: "unavailable no-review",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [["queued", null, null]],
    comments: ["@macroscope-app review", "noise"],
  },
  {
    name: "unreviewed-open",
    expected: "triage findings",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [["queued", null, null]],
    comments: ["@macroscope-app review", "noise"],
  },
  {
    name: "absent",
    expected: "wait check-appear",
    now: "2026-09-30T14:20:30Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [["queued", null, null]],
    comments: ["@macroscope-app review", "noise"],
  },
  {
    name: "absent",
    expected: "absent",
    now: "2026-09-30T14:50:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [["queued", null, null]],
    comments: ["@macroscope-app review", "noise"],
  },
  {
    name: "pending",
    expected: "unavailable timeout",
    now: "2026-09-30T14:50:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [["queued", null, null]],
    comments: ["@macroscope-app review", "noise"],
  },
  {
    name: "approval-pending",
    expected: "done clean",
    now: "2026-09-30T14:50:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "medium",
    approval: [["queued", null, null]],
    comments: ["@macroscope-app review", "noise"],
  },
  {
    name: "medium",
    expected: "done approved",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "2",
    threshold: "high",
    approval: [["queued", null, null]],
    comments: ["@macroscope-app review", "noise"],
  },
  {
    name: "medium",
    expected: "triage findings",
    now: "2026-09-30T14:30:00Z",
    critical: true,
    outcome: null,
    rereviews: "2",
    threshold: "high",
    approval: [["queued", null, null]],
    comments: ["@macroscope-app review", "noise"],
  },
  {
    name: "unreviewed",
    expected: "rereview paused",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "0",
    threshold: "medium",
    approval: [["queued", null, null]],
    comments: ["@macroscope-app review", "noise"],
  },
  {
    name: "medium",
    expected: "handback round-cap",
    now: "2026-09-30T14:30:00Z",
    critical: false,
    outcome: null,
    rereviews: "0",
    threshold: "medium",
    approval: [["queued", null, null]],
    comments: ["@macroscope-app review", "noise"],
  },
] as const;

for (const [index, entry] of cases.entries())
  test(`case_run ${entry.name} ${index + 1}`, () => {
    const approvalRows: CheckRun[] = entry.approval.map(([status, conclusion, startedAt]) => ({
      __typename: "CheckRun",
      name: "Macroscope - Approvability Check",
      status: status!.toUpperCase(),
      conclusion: conclusion ? conclusion.toUpperCase() : null,
      startedAt,
    }));

    const earlier: Comment[] = (entry.name === "buried-trigger" ? entry.comments : []).map(
      (body, index) => ({
        author: { login: "developer" },
        body,
        createdAt: index ? "2026-09-30T14:22:00Z" : "2026-09-30T14:21:00Z",
      }),
    );

    const snapshot = macroscopeFixture(entry.name, approvalRows, earlier);
    const input = inputFor("macroscope", snapshot, {
      now: entry.now,
      critical: entry.critical,
      outcome: entry.outcome,
    });

    input.settings.rereviews = entry.rereviews;
    input.settings.threshold = entry.threshold;

    expect(decide(facts(input), null, input)).toBe(entry.expected);
    expect(facts(input).fixesFrom).toBeNull();
  });

test("declared threshold patterns match the decision levels", () => {
  const declaration = readDeclarations(join(import.meta.dir, "../../skills")).find(
    (entry) => entry.name === "macroscope",
  )!;

  const levels = ["critical", "high", "medium", "low"];
  const candidates = [
    "0", "1", "2", "3", "4", "5", "6", "none", "other",
    "critical", "major", "minor", "trivial", "high", "medium", "low",
  ];

  for (const name of ["threshold", "critical-threshold"]) {
    const setting = declaration.settings.find((entry) => entry.name === name)!;
    for (const candidate of candidates)
      expect(matchesSetting(setting.pattern, candidate)).toBe(levels.includes(candidate));

    for (const level of levels) {
      expect(matchesSetting(setting.pattern, level + "\n")).toBe(false);
      expect(matchesSetting(setting.pattern, " " + level)).toBe(false);
    }
  }
});

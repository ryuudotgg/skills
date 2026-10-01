import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { facts, decide, type Facts } from "../../skills/coderabbit/reviewer.ts";
import { fixture, response, success } from "./fixtures.ts";
import { coderabbitFixture, coderabbitAcceptance, inputFor } from "./reviewer-fixtures.ts";
import rateLimited from "./coderabbit-rate-limited.json";
import { runRound } from "./round.ts";
import { snapshotPath } from "./snapshot.ts";
import type { PullRequest, ReviewerInput } from "./types.ts";

const temporary: string[] = [];

for (const [now, expected] of [
  ["2026-09-27T17:11:01Z", "unavailable rate-limited 2"],
  ["2026-09-27T16:58:30Z", "unavailable rate-limited 15"],
  ["2026-09-27T17:13:02Z", "rereview paused"],
] as const)
  test(`rate limited remaining window ${now}`, () => {
    const legacy = structuredClone(rateLimited.data.repository.pullRequest);
    const pr: PullRequest = {
      body: "",
      userContentEdits: { nodes: [] },
      ...legacy,
      commits: {
        nodes: legacy.commits.nodes.map(({ commit }) => ({
          commit: {
            ...commit,
            statusCheckRollup: {
              contexts: {
                nodes: commit.statusCheckRollup.contexts.nodes.map((context) => ({
                  ...context,
                  __typename: "StatusContext",
                  createdAt: commit.checkSuites.nodes[0]!.createdAt,
                })),
              },
            },
          },
        })),
      },
    };

    const input = inputFor(
      "coderabbit",
      { pr, comments: pr.comments.nodes, headChecks: {} },
      { now },
    );

    expect(decide(facts(input), null, input)).toBe(expected);
  });

for (const [name, args, expected] of [
  ["completed-head gate", ["gate", "18"], "done clean"],
  ["major gate verdict", ["gate", "18"], "triage findings"],
  ["major critical gate verdict", ["gate", "18", "critical=true"], "triage findings"],
  ["major decide without outcome", ["decide", "18", "feat/topic"], "triage findings"],
  ["major fixed outcome", ["decide", "18", "feat/topic", "coderabbit=fixed"], "triage findings"],
  [
    "major dismissed outcome",
    ["decide", "18", "feat/topic", "coderabbit=dismissed"],
    "handback all-dismissed",
  ],
  ["minor noncritical gate", ["gate", "18"], "done clean"],
  ["minor critical gate", ["gate", "18", "critical=true"], "triage findings"],
  ["appear decide", ["decide", "18", "main"], "wait check-appear"],
] as const)
  test(`verdict ${name}`, async () => {
    const value = fixture(["coderabbit"]);
    temporary.push(value.temporary);
    const snapshot = name.startsWith("appear")
      ? coderabbitAcceptance("appear")
      : coderabbitFixture(name.split(" ")[0]!);

    value.deps.env.REVIEW_NOW = name.startsWith("appear")
      ? "2026-09-28T12:00:00Z"
      : "2026-09-27T16:58:30Z";

    value.deps.sleep = async () => {
      value.advance(1260);
    };

    value.deps.gh = async (argv, deadline) => {
      value.calls.push({ command: "gh", args: argv, deadline });
      return success(response(snapshot.pr));
    };

    const result = await runRound(args, value.deps);

    expect(result.stdout.split("\n")[0]).toBe(`coderabbit ${expected}`);
    expect(result.stderr).toBe("");
    expect(value.calls.filter((call) => call.command === "gh")).toHaveLength(1);
    expect(value.calls.find((call) => call.command === "gh")!.args.at(-1)).toBe(
      `query=@${snapshotPath}`,
    );
  });

for (const gate of ["timeout", "no-review"] as const)
  test(`${gate} hid findings and lost rate limit`, () => {
    const input = inputFor("coderabbit", coderabbitFixture("major"));
    input.presence = {
      check: "missing",
      seen: true,
      event: "trigger",
      elapsed: 1500,
      age: null,
      gate,
    };

    const value: Facts = {
      approved: false,
      reviewed: false,
      limited: false,
      retry: null,
      reviews: 0,
      worst: "major",
      unanswered: "major",
      triggered: true,
      skipped: null,
      fixesFrom: null,
    };

    expect(decide(value, null, input)).toBe("triage findings");
    expect(
      decide({ ...value, limited: true, retry: 2, worst: "none", unanswered: "none" }, null, input),
    ).toBe("unavailable rate-limited 2");
  });

for (const [field, value] of [
  ["worst", "high"],
  ["retry", -1],
  ["reviews", 1.5],
  ["approved", "yes"],
  ["skipped", "held"],
] as const)
  test(`decide forged ${field} ${value}`, () => {
    const input = inputFor("coderabbit", coderabbitFixture("major"));

    expect(() =>
      decide({ ...facts(input), [field]: value } as unknown as Facts, null, input),
    ).toThrow("cannot decide review state");
  });

for (const [key, value] of [
  ["rereviews", "-1"],
  ["rereviews", "1.5"],
  ["threshold", "high"],
  ["critical-threshold", "low"],
])
  test(`settings refusal ${key} ${value}`, () => {
    const input = inputFor("coderabbit", coderabbitFixture("major"));
    input.settings[key!] = value!;
    expect(() => decide(facts(input), null, input)).toThrow("cannot decide review state");
  });

test("decide gate=unknown refusal", () => {
  const input = inputFor("coderabbit", coderabbitFixture("major"));
  input.presence.gate = "unknown" as ReviewerInput["presence"]["gate"];
  expect(() => decide(facts(input), null, input)).toThrow("cannot decide review state");
});

test("notice_seconds parses DOTALL and every unit, including zero", () => {
  const snapshot = coderabbitFixture("open-notice");
  const notice = snapshot.pr.comments.nodes[0]!;
  notice.updatedAt = "2026-09-27T16:58:30Z";
  notice.body = "rate limited by coderabbit.ai Please wait **1 hour\n2 minutes and 3 seconds**";

  expect(facts(inputFor("coderabbit", snapshot))).toMatchObject({ limited: true, retry: 63 });
  notice.body = "rate limited by coderabbit.ai Please wait **0 seconds**";
  expect(facts(inputFor("coderabbit", snapshot))).toMatchObject({ limited: false, retry: null });
});

test("notice max retains the first timestamp tie", () => {
  const snapshot = coderabbitFixture("open-notice");
  const first = snapshot.pr.comments.nodes[0]!;
  first.updatedAt = "2026-09-27T16:58:30Z";
  snapshot.pr.comments.nodes.push({
    ...first,
    body: "rate limited by coderabbit.ai Please wait **1 minute**",
  });

  expect(facts(inputFor("coderabbit", snapshot)).retry).toBe(15);
});

test("last matching check includes EXPECTED", () => {
  const snapshot = coderabbitFixture("completed-head");
  snapshot.pr.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes.push({
    __typename: "StatusContext",
    context: "CodeRabbit",
    state: "EXPECTED",
    createdAt: "2026-09-27T16:50:00Z",
    description: "Review skipped: automatic reviews are disabled",
  });

  expect(facts(inputFor("coderabbit", snapshot))).toMatchObject({
    reviewed: false,
    skipped: "disabled",
  });
});

test("CodeRabbit keeps trigger and notice reads on the newest comments page", () => {
  const snapshot = coderabbitFixture("paused");
  snapshot.comments = [
    { author: null, body: "@coderabbitai review", createdAt: "2026-09-27T16:58:00Z" },
    ...snapshot.comments,
  ];

  expect(facts(inputFor("coderabbit", snapshot)).triggered).toBe(false);
});

test("cannot parse PR review", () => {
  const snapshot = coderabbitFixture("major");
  snapshot.pr.commits.nodes[0]!.commit.committedDate = "2026-02-30T00:00:00Z";
  expect(() => facts(inputFor("coderabbit", snapshot))).toThrow("cannot parse PR review");
});

test("terminal state changed verdict without another snapshot", () => {
  const input = inputFor("coderabbit", coderabbitFixture("major"));
  const terminal = facts(input);

  expect(decide(terminal, null, input)).toBe("triage findings");
  expect(decide(terminal, null, input)).toBe("triage findings");
});

for (const args of [
  ["gate", "x"],
  ["gate", "18", "coderabbit=fixed"],
  ["decide", "18", "feat/topic", "coderabbit=other"],
])
  test(`usage verdict ${args.join(" ")}`, async () => {
    const value = fixture(["coderabbit"]);
    temporary.push(value.temporary);

    const result = await runRound(args, value.deps);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(value.calls).toHaveLength(0);
  });

test("counts and oid need a nonempty commit id", () => {
  const snapshot = coderabbitFixture("major");
  snapshot.pr.reviews.nodes.push({ ...snapshot.pr.reviews.nodes[0]!, commit: { oid: "" } });
  expect(facts(inputFor("coderabbit", snapshot)).reviews).toBe(1);
});

test("outside_levels uses Python splitlines and lstrip", () => {
  const snapshot = coderabbitFixture("outside-minor");
  const review = snapshot.pr.reviews.nodes[0]!;
  review.body = review.body!.replace(/^>/gm, "\u001f >").replaceAll("\n", "\u0085");

  expect(facts(inputFor("coderabbit", snapshot)).worst).toBe("minor");
});

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

const cases = [
  {
    name: "major",
    expected: "triage findings",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "approved",
    expected: "done approved",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "approved-then-review",
    expected: "triage findings",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "trivial",
    expected: "done clean",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "old-major",
    expected: "triage findings",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "budget",
    expected: "handback round-cap",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "minor",
    expected: "triage findings",
    now: "2026-09-27T16:58:30Z",
    critical: true,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "paused",
    expected: "rereview paused",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "triggered",
    expected: "unavailable no-review",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "dismissed",
    expected: "handback all-dismissed",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: "dismissed",
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "full-threads",
    expected: "triage findings",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "full-reviews",
    expected: "handback round-cap",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "old-approved",
    expected: "rereview paused",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "empty",
    expected: "rereview paused",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "real-line",
    expected: "done clean",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "no-severity",
    expected: "triage findings",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "outside-major",
    expected: "triage findings",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "outside-minor",
    expected: "done clean",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "outside-mismatch",
    expected: "triage findings",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "ready",
    expected: "rereview paused",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "status-limited",
    expected: "unavailable rate-limited",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "limited-old-major",
    expected: "triage findings",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "limited-answered-major",
    expected: "unavailable rate-limited",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "pending",
    expected: "wait check-pending",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "completed-head",
    expected: "done clean",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "completed-old-major",
    expected: "triage findings",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "approved-status",
    expected: "done clean",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "skipped-disabled",
    expected: "rereview paused",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "skipped-ineligible",
    expected: "unavailable skipped",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "completed-budget",
    expected: "handback round-cap",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "completed-and-review",
    expected: "triage findings",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "expected",
    expected: "wait check-appear",
    now: "2026-09-27T16:50:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "absent",
    expected: "wait check-appear",
    now: "2026-09-27T16:50:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "old-notice",
    expected: "rereview paused",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "open-notice",
    expected: "unavailable rate-limited 6",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "notice-pending",
    expected: "wait check-pending",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "old-wait",
    expected: "unavailable rate-limited 2",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "major",
    expected: "triage findings",
    now: "2026-09-27T16:58:30Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "pending",
    expected: "unavailable timeout",
    now: "2026-09-27T17:20:00Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "status-limited",
    expected: "rereview paused",
    now: "2026-09-27T17:20:00Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "trigger-limited",
    expected: "unavailable no-review",
    now: "2026-09-27T17:20:00Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "absent",
    expected: "absent",
    now: "2026-09-27T17:20:00Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "expected",
    expected: "absent",
    now: "2026-09-27T17:20:00Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "paused",
    expected: "rereview paused",
    now: "2026-09-27T17:20:00Z",
    critical: false,
    outcome: null,
    rereviews: "3",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "skipped-disabled-budget",
    expected: "unavailable paused",
    now: "2026-09-27T17:20:00Z",
    critical: false,
    outcome: null,
    rereviews: "0",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "skipped-ineligible",
    expected: "unavailable skipped",
    now: "2026-09-27T17:20:00Z",
    critical: false,
    outcome: null,
    rereviews: "0",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "paused-budget",
    expected: "unavailable paused",
    now: "2026-09-27T17:20:00Z",
    critical: false,
    outcome: null,
    rereviews: "0",
    threshold: "major",
    approval: [],
    comments: [],
  },
  {
    name: "major",
    expected: "handback round-cap",
    now: "2026-09-27T17:20:00Z",
    critical: false,
    outcome: null,
    rereviews: "0",
    threshold: "major",
    approval: [],
    comments: [],
  },
] as const;

for (const [index, entry] of cases.entries())
  test(`case_run ${entry.name} ${index + 1}`, () => {
    const snapshot = coderabbitFixture(entry.name);
    const input = inputFor("coderabbit", snapshot, {
      now: entry.now,
      critical: entry.critical,
      outcome: entry.outcome,
    });

    input.settings.rereviews = entry.rereviews;
    input.settings.threshold = entry.threshold;

    expect(decide(facts(input), null, input)).toBe(entry.expected);
    expect(facts(input).fixesFrom).toBeNull();
  });

const acceptance = [
  ["pending", "wait check-pending"],
  ["appear", "wait check-appear"],
  ["absent", "absent"],
  ["trigger", "unavailable no-review"],
  ["trigger-old", "unavailable no-review"],
  ["timeout", "unavailable timeout"],
  ["pending-boundary", "unavailable timeout"],
  ["appear-boundary", "absent"],
  ["trigger-boundary", "unavailable no-review"],
  ["trigger-tie", "unavailable no-review"],
  ["future", "wait check-appear"],
  ["push-suite", "wait check-appear"],
  ["newest-time", "wait check-pending"],
  ["tie-time", "wait check-pending"],
  ["ready", "wait check-appear"],
  ["open", "wait check-appear"],
  ["human-only", "absent"],
  ["full-suites", "absent"],
  ["seen-push", "rereview paused"],
  ["expected", "absent"],
  ["full-reviews", "unavailable paused"],
  ["body-seen", "rereview paused"],
  ["thread-seen", "rereview paused"],
  ["full-edits", "rereview paused"],
  ["full-comments", "rereview paused"],
  ["full-threads", "rereview paused"],
  ["full-commits", "rereview paused"],
  ["full-contexts", "rereview paused"],
] as const;

for (const [name, expected] of acceptance)
  test(`acceptance_case ${name}`, async () => {
    const value = fixture(["coderabbit"]);
    temporary.push(value.temporary);
    const snapshot = coderabbitAcceptance(name);
    value.deps.env.REVIEW_NOW = "2026-09-28T12:00:00Z";
    value.deps.gh = async (args, deadline) => {
      value.calls.push({ command: "gh", args, deadline });
      return success(response(snapshot));
    };

    const result = await runRound(["gate", "18"], value.deps);

    expect(result.code).toBe(0);
    expect(result.stdout.split("\n")[0]).toBe(`coderabbit ${expected}`);
    expect(value.calls.filter((call) => call.command === "gh")).toHaveLength(1);
  });

test("missing OUTSIDE_DIFF refuses instead of matching undefined", () => {
  const snapshot = coderabbitFixture("major");
  const input = inputFor("coderabbit", snapshot);
  const { outsideDiff: _, ...declaration } = input.declaration;

  expect(() => facts({ ...input, declaration })).toThrow("cannot parse PR review");
});

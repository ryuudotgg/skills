import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { readDeclarations } from "../reviewers/declaration.ts";
import { acceptanceCases, fixture, now } from "./fixtures.ts";
import { limits, presence } from "./presence.ts";
import { parseRound } from "./round.ts";

const temporary: string[] = [];

afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

test("check limits are fixed", () => {
  expect(limits).toEqual({ window: 60, start: 180, cap: 1200 });
});

for (const args of [
  ["x", "CHECK", "TRIGGER", "LOGINS"],
  ["18", "CHECK", "TRIGGER", "one", "two"],
  ["18", "", "TRIGGER", "LOGINS"],
])
  test(`usage: reviewer round ${JSON.stringify(args)}`, () => {
    expect(() => parseRound(["gate", args[0]!, ...args.slice(1)])).toThrow();
  });

test.concurrent("shared reader facts, ties and queued starts use UTC seconds", async () => {
  const value = fixture();
  temporary.push(value.temporary);

  const pr = structuredClone(acceptanceCases.find((entry) => entry.name === "absent")!.pr);
  pr.createdAt = now;
  pr.timelineItems.nodes = [{ createdAt: now }];
  pr.comments.nodes = [{ author: { login: "developer" }, body: " @greptileai ", createdAt: now }];
  pr.commits.nodes = [
    {
      commit: {
        oid: "a".repeat(40),
        committedDate: now,
        checkSuites: { nodes: [] },
        statusCheckRollup: {
          contexts: {
            nodes: [
              {
                __typename: "CheckRun",
                name: "Greptile Review",
                status: "QUEUED",
                startedAt: null,
                completedAt: null,
                checkSuite: { createdAt: now },
              },
            ],
          },
        },
      },
    },
  ];

  const declaration = { ...readDeclarations(value.root)[0]!, check: "rEvIeW" };
  const actual = presence(
    { pr, comments: pr.comments.nodes, headChecks: {} },
    declaration,
    "2026-09-28T12:00:30Z",
  );

  expect(actual).toEqual({
    check: "pending",
    seen: true,
    event: "trigger",
    elapsed: 30,
    age: 30,
    gate: "pending",
  });

  for (const invalid of [
    "2026-09-28T16:00:30+04:00",
    "20260928T120030Z",
    "2026-09-28T12:00:30.000Z",
    "2026-09-28T12:00:30.000001Z",
    "2026-09-28T12:00Z",
    "2026-09-28",
    "2026-09-28T12:00:30Z\n",
    "2026-02-30T12:00:30Z",
    "2026-09-28T24:00:00Z",
  ])
    expect(() =>
      presence({ pr, comments: pr.comments.nodes, headChecks: {} }, declaration, invalid),
    ).toThrow("cannot parse PR checks");
});

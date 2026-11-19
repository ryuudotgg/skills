import { expect, test } from "bun:test";
import { authorMatcher, headContexts, openThreads, worst } from "./reviewer-kit.ts";
import type { CheckRun, Snapshot } from "./types.ts";

const rank = { minor: 0, critical: 1 };
const level = (line: string) => (line.includes("Minor") ? "minor" : "critical");
const seen = authorMatcher({ logins: ["reviewer[bot]"] });
const thread = () => ({
  isResolved: false,
  comments: {
    nodes: [{ author: { login: "Reviewer[bot]" }, body: "\n🟡 Minor: rename this" }],
  },
  latest: { nodes: [{ author: { login: "reviewer[bot]" } }] },
});

test("full thread page reads critical", () => {
  const full = openThreads({ nodes: Array.from({ length: 100 }, thread) }, seen, level);
  expect(worst(full.levels, rank)).toBe("critical");
  expect(worst(full.unanswered, rank)).toBe("critical");

  const partial = openThreads({ nodes: Array.from({ length: 99 }, thread) }, seen, level);
  expect(worst(partial.levels, rank)).toBe("minor");
  expect(worst(partial.unanswered, rank)).toBe("minor");
});

const run = (name: string, suite?: string): CheckRun => ({
  __typename: "CheckRun",
  name,
  status: "QUEUED",
  conclusion: null,
  startedAt: null,
  completedAt: null,
  ...(suite ? { checkSuite: { createdAt: suite } } : {}),
});

const headSnapshot = (
  truncated: boolean,
  suites: Snapshot["pr"]["commits"]["nodes"][number]["commit"]["checkSuites"]["nodes"],
) =>
  ({
    pr: {
      commits: {
        nodes: [
          {
            commit: {
              oid: "a".repeat(40),
              committedDate: "2026-09-30T14:00:00Z",
              checkSuites: { nodes: suites },
              statusCheckRollup: {
                contexts: {
                  nodes: [run("build")],
                  pageInfo: { hasNextPage: truncated },
                },
              },
            },
          },
        ],
      },
    },
    comments: [],
    headChecks: {
      first: [run("first")],
      second: [run("second", "2026-09-30T14:05:00Z")],
    },
  }) as unknown as Snapshot;

const appSuites = [
  { createdAt: "2026-09-30T14:10:00Z", app: { slug: "reviewer" } },
  { createdAt: "2026-09-30T14:20:00Z", app: { slug: "reviewer" } },
  { createdAt: "2026-09-30T14:30:00Z", app: { slug: "other" } },
  { createdAt: "2026-09-30T14:40:00Z" },
];

test("head contexts read the first page alone on a head that is not truncated", () => {
  expect(headContexts(headSnapshot(false, appSuites), ["first", "second"], seen)).toEqual([
    run("build"),
  ]);
});

test("head contexts append the fetched runs of the names asked for on a truncated head", () => {
  expect(headContexts(headSnapshot(true, []), ["second"], seen)).toEqual([
    run("build"),
    run("second", "2026-09-30T14:05:00Z"),
  ]);

  expect(headContexts(headSnapshot(true, []), ["first", "missing"], seen)).toBeNull();
});

test("head contexts give a run with no suite the newest app suite time", () => {
  expect(headContexts(headSnapshot(true, appSuites), ["first", "second"], seen)).toEqual([
    run("build"),
    run("first", "2026-09-30T14:20:00Z"),
    run("second", "2026-09-30T14:05:00Z"),
  ]);

  expect(headContexts(headSnapshot(true, appSuites.slice(2)), ["first"], seen)).toEqual([
    run("build"),
    run("first"),
  ]);
});

test("head contexts skip a fetched run the first page already lists", () => {
  const snapshot = headSnapshot(true, appSuites);
  snapshot.pr.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes = [
    run("first", "2026-09-30T14:00:00Z"),
  ];

  snapshot.headChecks.first = [run("first"), run("first")];

  expect(headContexts(snapshot, ["first"], seen)).toEqual([
    run("first", "2026-09-30T14:00:00Z"),
    run("first", "2026-09-30T14:20:00Z"),
  ]);
});

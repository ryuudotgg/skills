import { join } from "node:path";
import { reviewerDeclarations } from "./watch.ts";
import { describe, expect, it } from "bun:test";
import {
  GhGitHubReader,
  WatcherQueryError,
  mapRollupNode,
  orderStack,
  parsePullRequest,
  parseReviewThreads,
  resolveContext,
} from "./github.ts";
import { fakeReader } from "./fakes.ts";
import { parsePrNumber } from "./types.ts";

const reviewers = reviewerDeclarations(join(import.meta.dir, "../../skills"));

const context = {
  owner: "owner",
  repo: "repo",
  number: parsePrNumber(42),
};

const answer = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });

function connection(nodes: readonly unknown[], hasNextPage = false, endCursor: string | null = null) {
  return { nodes, pageInfo: { hasNextPage, endCursor } };
}

function runCheck(databaseId: number, status = "COMPLETED", workflow = "build", event = "push") {
  return { __typename: "CheckRun", databaseId, name: "ci", title: "check title", status,
    conclusion: status === "COMPLETED" ? "SUCCESS" : null, detailsUrl: "https://example.com/check",
    checkSuite: { workflowRun: { event, workflow: { name: workflow } } },
  };
}

async function pollResponse(contexts = connection([runCheck(1)])) {
  const read = await fakeReader().read(context);
  return { data: { repository: { pullRequest: {
    ...read.facts,
    commits: { nodes: [{ commit: { oid: "head", statusCheckRollup: { state: "SUCCESS" } } }] },
    head: { nodes: [{ commit: { oid: "head", statusCheckRollup: { contexts } } }] },
    reviewThreads: connection([]),
  } } } };
}

describe("whole poll reader", () => {
  it("returns UNKNOWN without sleeping or an in-reader merge-state reread", async () => {
    const response = await pollResponse();
    response.data.repository.pullRequest.mergeStateStatus = "UNKNOWN";
    const calls: (readonly string[])[] = [];
    const deadlines: number[] = [];
    const reader = new GhGitHubReader(reviewers, async (argv, deadline) => {
      calls.push(argv);
      deadlines.push(deadline);
      return answer(response);
    }, () => 123);

    expect((await reader.read(context)).facts.mergeStateStatus).toBe("UNKNOWN");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.find((argument) => argument.startsWith("query="))).toStartWith("query=query PrPoll(");
    expect(deadlines).toEqual([123]);
  });

  it("deduplicates after paging by workflow and event and keeps the newest created run", async () => {
    const first = await pollResponse(connection([
      runCheck(2),
      runCheck(2, "COMPLETED", "other"),
      runCheck(2, "COMPLETED", "build", "pull_request"),
      { __typename: "StatusContext", context: "status", state: "PENDING" },
    ], true, "next"));
    const second = await pollResponse(connection([
      runCheck(1),
      runCheck(3, "QUEUED"),
      { __typename: "StatusContext", context: "status", state: "SUCCESS" },
    ]));
    let calls = 0;
    const reader = new GhGitHubReader(reviewers, async () => answer(++calls === 1 ? first : second));

    const read = await reader.read(context);
    expect(calls).toBe(2);
    expect(read.checks).toHaveLength(4);
    expect(read.checks[0]).toMatchObject({ kind: "pending", description: "check title", workflow: "build", link: "https://example.com/check" });
    expect(read.checks[1]).toMatchObject({ kind: "passed", workflow: "other" });
    expect(read.checks[2]).toMatchObject({ kind: "passed", workflow: "build" });
    expect(read.checks[3]).toMatchObject({ kind: "passed", name: "status" });
  });

  it("lets a newer failed rerun replace an older pass that reported no start time", async () => {
    const older = { ...runCheck(4), startedAt: null };
    const newer = { ...runCheck(5), conclusion: "FAILURE", startedAt: "2026-10-02T01:00:00Z" };
    const reader = new GhGitHubReader(reviewers, async () => answer(await pollResponse(connection([newer, older]))));

    expect((await reader.read(context)).checks).toMatchObject([{ name: "ci", kind: "failed" }]);
  });

  it("keeps same named runs from different apps apart and reads status descriptions", async () => {
    const circle = { ...runCheck(1), conclusion: "FAILURE",
      checkSuite: { app: { slug: "circleci-checks" }, workflowRun: null },
    };
    const other = { ...runCheck(2), checkSuite: { app: { slug: "other-ci" }, workflowRun: null } };
    const status = { __typename: "StatusContext", context: "Vercel", state: "SUCCESS", description: "Deployment has completed" };
    const response = await pollResponse(connection([circle, other, status]));
    const reader = new GhGitHubReader(reviewers, async () => answer(response));

    expect((await reader.read(context)).checks).toMatchObject([
      { name: "ci", kind: "failed" },
      { name: "ci", kind: "passed" },
      { name: "Vercel", kind: "passed", description: "Deployment has completed" },
    ]);
  });

  it("replaces the whole read immediately once when a thread page sees a different head", async () => {
    const first = await pollResponse();
    const initial = first.data.repository.pullRequest;
    initial.reviewThreads = connection([{ id: "discarded", isResolved: false, starter: { nodes: [] } }], true, "next");
    const replacement = await pollResponse(connection([runCheck(3, "QUEUED")]));
    const latest = replacement.data.repository.pullRequest;
    latest.headRefOid = "new-head";
    latest.head.nodes[0]!.commit.oid = "new-head";
    latest.commits.nodes[0]!.commit.oid = "new-head";
    const responses = [first, { data: { repository: { pullRequest: { headRefOid: "new-head" } } } }, replacement];
    let calls = 0;
    const reader = new GhGitHubReader(reviewers, async () => answer(responses[calls++]));

    expect(await reader.read(context)).toMatchObject({ facts: { headRefOid: "new-head" },
      checks: [{ kind: "pending" }], rollups: [{ oid: "new-head" }], threads: [],
    });
    expect(calls).toBe(3);
  });

  it("checks both head oids on every contexts page and checks the first page commit oid", async () => {
    for (const moved of ["initial-commit", "page-head", "page-commit"] as const) {
      const first = await pollResponse(connection([runCheck(3, "QUEUED")], true, "next"));
      const page = await pollResponse();
      if (moved === "initial-commit") first.data.repository.pullRequest.head.nodes[0]!.commit.oid = "other";
      if (moved === "page-head") page.data.repository.pullRequest.headRefOid = "other";
      if (moved === "page-commit") page.data.repository.pullRequest.head.nodes[0]!.commit.oid = "other";

      let calls = 0;
      const reader = new GhGitHubReader(reviewers, async (argv) => {
        calls++;
        return answer(argv.includes("after=next") ? page : first);
      });

      await expect(reader.read(context)).rejects.toMatchObject({ failure: { kind: "merge-state-unknown", retryable: true } });
      expect(calls).toBe(moved === "initial-commit" ? 2 : 4);
    }
  });

  it("refuses a null or empty contexts cursor without fetching another page", async () => {
    for (const cursor of [null, ""]) {
      const response = await pollResponse(connection([], true, cursor));
      let calls = 0;
      const reader = new GhGitHubReader(reviewers, async () => { calls++; return answer(response); });

      await expect(reader.read(context)).rejects.toMatchObject({ failure: { kind: "missing-key", retryable: true } });
      expect(calls).toBe(1);
    }
  });

  it("turns shared thread parser failures and repeating thread cursors into watcher errors", async () => {
    for (const threads of [{ nodes: [] }, connection([{ id: "one", isResolved: false }]), connection([], true, "same")]) {
      const response = await pollResponse();
      response.data.repository.pullRequest.reviewThreads = threads as ReturnType<typeof connection>;
      let calls = 0;
      const reader = new GhGitHubReader(reviewers, async () => { calls++; return answer(response); });

      await expect(reader.read(context)).rejects.toBeInstanceOf(WatcherQueryError);
      expect(calls).toBeLessThanOrEqual(2);
    }
  });

  it("does not inspect ancillary data or fetch pages for merged or closed PRs", async () => {
    for (const state of ["MERGED", "CLOSED"] as const) {
      const read = await fakeReader({ facts: { state } }).read(context);
      let calls = 0;
      const reader = new GhGitHubReader(reviewers, async () => {
        calls++;
        return answer({ data: { repository: { pullRequest: read.facts } } });
      });

      expect(await reader.read(context)).toEqual({ facts: read.facts, checks: [], rollups: [], threads: [] });
      expect(calls).toBe(1);
    }
  });

  it("never treats command failures, malformed JSON or GraphQL errors as empty checks", async () => {
    for (const [response, kind] of [
      [{ code: 8, stdout: "[]", stderr: "credential cannot read checks" }, "command-exit"],
      [{ code: 0, stdout: "not JSON", stderr: "" }, "json-parse"],
      [answer({ data: { repository: { pullRequest: null } }, errors: [{ message: "denied" }] }), "missing-key"],
    ] as const) {
      const reader = new GhGitHubReader(reviewers, async () => response);
      await expect(reader.read(context)).rejects.toMatchObject({ failure: { kind, retryable: true } });
    }
  });
});

describe("rollup node mapping", () => {
  it("maps terminal and non-terminal CheckRun states fail closed", () => {
    const cases = [
      ["IN_PROGRESS", null, "pending", "PENDING"],
      ["COMPLETED", "SUCCESS", "passed", "SUCCESS"],
      ["COMPLETED", "NEUTRAL", "skipped", "NEUTRAL"],
      ["COMPLETED", "SKIPPED", "skipped", "SKIPPED"],
      ["COMPLETED", "ACTION_REQUIRED", "failed", "ACTION_REQUIRED"],
      ["COMPLETED", "TIMED_OUT", "failed", "FAILURE"],
      ["COMPLETED", "FUTURE_VALUE", "failed", "FAILURE"],
    ] as const;

    for (const [status, conclusion, kind, reportedState] of cases)
      expect(
        mapRollupNode({
          __typename: "CheckRun",
          name: "ci",
          status,
          conclusion,
        })
      ).toMatchObject({ kind, reportedState });
  });

  it("classifies an in-progress Code Review Gate from the rollup as the gate", () => {
    expect(
      mapRollupNode({
        __typename: "CheckRun",
        name: "Code Review Gate",
        status: "IN_PROGRESS",
        conclusion: null,
      })
    ).toMatchObject({ kind: "code-review-gate" });

    expect(
      mapRollupNode({
        __typename: "StatusContext",
        context: "Code Review Gate",
        state: "PENDING",
      })
    ).toMatchObject({ kind: "code-review-gate" });
  });

  it("maps StatusContext states and drops unknown typenames", () => {
    expect(
      mapRollupNode({
        __typename: "StatusContext",
        context: "ci",
        state: "EXPECTED",
      })
    ).toMatchObject({ kind: "pending", reportedState: "PENDING" });

    expect(
      mapRollupNode({
        __typename: "StatusContext",
        context: "ci",
        state: "FUTURE_VALUE",
      })
    ).toMatchObject({ kind: "failed", reportedState: "FUTURE_VALUE" });

    expect(mapRollupNode({ __typename: "FutureNode" })).toBeNull();
  });
});

describe("closed enum parsing", () => {
  const rawPullRequest = {
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    headRefOid: "head",
    headRefName: "feature",
    baseRefName: "main",
    state: "OPEN",
    mergedAt: null,
    isDraft: false,
  };

  it("accepts mergeStateStatus CONFLICTING", () => {
    expect(
      parsePullRequest(
        { ...rawPullRequest, mergeStateStatus: "CONFLICTING" },
        context
      ).mergeStateStatus
    ).toBe("CONFLICTING");
  });

  it("reads gh's empty reviewDecision as no decision rather than a parse failure", () => {
    expect(
      parsePullRequest({ ...rawPullRequest, reviewDecision: "" }, context)
        .reviewDecision
    ).toBeNull();
  });

  it("still rejects an unknown reviewDecision", () => {
    expect(() =>
      parsePullRequest({ ...rawPullRequest, reviewDecision: "MAYBE" }, context)
    ).toThrow(WatcherQueryError);
  });

  it("rejects unknown enum values as retryable errors carrying the raw value", () => {
    try {
      parsePullRequest(
        { ...rawPullRequest, mergeStateStatus: "FUTURE_STATE" },
        context
      );

      throw new Error("expected parser to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(WatcherQueryError);
      if (!(error instanceof WatcherQueryError)) throw error;

      expect(error.failure).toMatchObject({
        kind: "missing-key",
        retryable: true,
        rawValue: '"FUTURE_STATE"',
      });
    }
  });
});

const thread = (
  id: string,
  isResolved: boolean,
  body: string,
  login: string,
  createdAt: string
) => ({
  id,
  isResolved,
  starter: { body, createdAt, path: null, line: null, login },
  comments: [],
});
const threadsResponse = (nodes: ReturnType<typeof thread>[]) => nodes;

it("counts a review pass per stamped run id", () => {
  const threads = parseReviewThreads(
    threadsResponse([
      thread("one", false, "RUN_ID: run-1 confidence score 8", "bot-a[bot]", "2026-08-31T10:00:00Z"),
      thread("two", false, "REVIEW_ID: run-2 confidence score 4", "bot-a[bot]", "2026-08-31T10:00:05Z"),
      thread("done", true, "RUN_ID: run-3 confidence score 9", "bot-a[bot]", "2026-08-31T10:00:09Z"),
    ]),
    reviewers
  );

  expect(threads).toHaveLength(2);
  expect(threads.map((t) => t.isReviewBot)).toEqual([true, true]);
  expect(threads.map((t) => t.reviewBotPasses)).toEqual([3, 3]);
});

it("counts passes by comment time when the bot stamps no run id", () => {
  const threads = parseReviewThreads(
    threadsResponse([
      thread("a1", false, "Comments outside diff: nullable viewer", "rev[bot]", "2026-08-31T10:00:00Z"),
      thread("a2", false, "Confidence score: 7. Missing guard.", "rev[bot]", "2026-08-31T10:00:30Z"),
      thread("a3", false, "Confidence score: 3. Naming.", "rev[bot]", "2026-08-31T10:01:10Z"),
      thread("b1", false, "Confidence score: 6. Still unguarded.", "rev[bot]", "2026-08-31T11:00:00Z"),
    ]),
    reviewers
  );

  expect(threads).toHaveLength(4);
  expect(threads.every((t) => t.isReviewBot)).toBe(true);
  expect(threads[0]?.reviewBotPasses).toBe(2);
});

it("does not treat a human as a review bot", () => {
  const threads = parseReviewThreads(
    threadsResponse([
      thread("h", false, "confidence score looks off here", "greptile-fan", "2026-08-31T10:00:00Z"),
      thread("d", false, "Severity: high. Bump lodash.", "dependabot[bot]", "2026-08-31T10:00:00Z"),
    ]),
    reviewers
  );

  expect(threads.map((t) => t.isReviewBot)).toEqual([false, false]);
  expect(threads.map((t) => t.reviewBotPasses)).toEqual([0, 0]);
});

it("recognizes a declared reviewer without a bot suffix or body phrase", () => {
  const threads = parseReviewThreads(
    threadsResponse([
      thread("declared", false, "Please check this guard.", "coderabbitai", "2026-08-31T10:00:00Z"),
    ]),
    reviewers
  );

  expect(threads[0]?.isReviewBot).toBe(true);
});

describe("context and stack discovery", () => {
  it("returns a fully explicit context without any reader call", async () => {
    const reader = fakeReader();
    expect(
      await resolveContext({
        reader,
        owner: "explicit",
        repo: "repo",
        pr: context.number,
      })
    ).toEqual({ owner: "explicit", repo: "repo", number: context.number });

    expect(reader.calls).toEqual([]);
  });

  it("uses the local origin before currentPr for an explicit number", async () => {
    const reader = fakeReader({ origin: { owner: "local", repo: "checkout" } });
    expect(
      await resolveContext({
        reader,
        owner: null,
        repo: null,
        pr: context.number,
      })
    ).toEqual({ owner: "local", repo: "checkout", number: context.number });

    expect(reader.calls).toEqual(["originRepo"]);
  });

  it("orders the connected stack bottom-to-top", () => {
    const ordered = orderStack(context, [
      {
        number: parsePrNumber(41),
        headRefName: "base-feature",
        baseRefName: "main",
      },
      {
        number: context.number,
        headRefName: "feature",
        baseRefName: "base-feature",
      },
      {
        number: parsePrNumber(43),
        headRefName: "upstack",
        baseRefName: "feature",
      },
    ]);

    expect(ordered.map((item) => Number(item.number))).toEqual([41, 42, 43]);
  });
});

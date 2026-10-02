import { describe, expect, it } from "bun:test";
import { WatcherQueryError } from "./github.ts";
import { renderPretty } from "./render.ts";
import { join } from "node:path";
import { reviewerDeclarations } from "./watch.ts";
import {
  applyQueueSnapshot,
  assessGitHubMerge,
  classifyPr,
  createQueueState,
  evaluateQueue,
  planQueue,
  queryBackoffSeconds,
  readSnapshot,
  runQueued,
  runSimple,
  selectTierMajorStackDecision,
} from "./policy.ts";
import {
  type FakeReaderOptions,
  fakeReader,
  failedCheck,
  passingCheck,
  pendingCheck,
} from "./fakes.ts";
import type {
  GitHubReader,
  NonEmpty,
  PollingOptions,
  PrContext,
  ProgressVerdict,
  PullRequestFacts,
  RollupState,
  ReviewDecision,
} from "./types.ts";
import { parsePrNumber } from "./types.ts";

const context = (number: number): PrContext => ({
  owner: "owner",
  repo: "repo",
  number: parsePrNumber(number),
});
const options = {
  interval: 10,
  sweepInterval: 300,
  timeout: 0,
  maxQueryErrors: 5,
  allowDraft: false,
} satisfies PollingOptions;

async function openSnapshot(pr: PrContext, readerOptions: FakeReaderOptions = {}) {
  return readSnapshot({
    reviewerChecks: [],
    reader: fakeReader(readerOptions),
    context: pr,

    allowDraft: false,
  });
}

describe("readiness truth table", () => {
  it("covers every merge state, rollup and review decision", () => {
    const rollups: readonly RollupState[] = ["ERROR", "EXPECTED", "FAILURE", "PENDING", "SUCCESS", null];
    const reviews: readonly ReviewDecision[] = ["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED", null];
    const allowed = ["CLEAN", "HAS_HOOKS", "UNSTABLE", "DRAFT"] as const;
    const refused = ["BEHIND", "DIRTY", "CONFLICTING"] as const;
    for (const headRollupState of rollups)
      for (const reviewDecision of reviews)
        for (const approvalGatePending of [false, true]) {
          const assess = (mergeStateStatus: PullRequestFacts["mergeStateStatus"]) =>
            assessGitHubMerge({ mergeStateStatus, headRollupState, reviewDecision, approvalGatePending });

          for (const mergeStateStatus of allowed)
            expect<unknown>(assess(mergeStateStatus)).toEqual({
              kind: "allowed", basis: "merge-state", mergeStateStatus, headRollupState,
            });

          for (const mergeStateStatus of refused)
            expect<unknown>(assess(mergeStateStatus)).toEqual({ kind: "refused", mergeStateStatus, headRollupState });

          expect<unknown>(assess("UNKNOWN")).toEqual({ kind: "undetermined", mergeStateStatus: "UNKNOWN", headRollupState });

          const failing = headRollupState === "FAILURE" || headRollupState === "ERROR";
          const awaitingApproval = reviewDecision === "REVIEW_REQUIRED" || approvalGatePending;
          const kind = failing
            ? "refused"
            : awaitingApproval
              ? "review-required"
              : headRollupState === "PENDING" || headRollupState === "EXPECTED"
                ? "undetermined"
                : "refused";

          expect<unknown>(assess("BLOCKED")).toEqual({ kind, mergeStateStatus: "BLOCKED", headRollupState });
        }
  });

  it("throws a retryable failure for UNKNOWN with clean checks", async () => {
    const row = await openSnapshot(context(1), { facts: { mergeStateStatus: "UNKNOWN" } });

    expect(() => classifyPr(row)).toThrow(WatcherQueryError);

    try {
      classifyPr(row);
    } catch (error) {
      expect(error).toMatchObject({ failure: {
        kind: "merge-state-unknown", retryable: true,
        detail: "GitHub has not settled mergeStateStatus=UNKNOWN for #1",
      } });
    }

    expect(() => selectTierMajorStackDecision([row])).toThrow(WatcherQueryError);
  });

  it("blocks a settled BLOCKED PR unless owner approval is the remaining gate", async () => {
    for (const headRollupState of ["SUCCESS", null] as const)
      for (const reviewDecision of ["APPROVED", "REVIEW_REQUIRED"] as const) {
        const row = await openSnapshot(context(2), {
          facts: { mergeStateStatus: "BLOCKED", reviewDecision },
          commitRollups: [{ oid: "head", state: headRollupState }],
        });

        const decision = classifyPr(row);

        expect(decision).toMatchObject({ kind: "blocker", blocker: reviewDecision === "REVIEW_REQUIRED"
          ? { kind: "merge-gate", reason: "review-required" }
          : { kind: "failing-checks", ci: { kind: "ci-github-rejected" } },
        });

        if (decision.kind !== "blocker") throw new Error("expected blocker");

        expect(renderPretty({ schemaVersion: 1, sequence: 1, observedAt: "now", mode: "single",
          kind: "STATUS", terminal: true, exitCode: 0, reason: "status-only", rows: [row],
        })).toContain(reviewDecision === "REVIEW_REQUIRED" ? "✅" : "❌ GitHub blocks the merge");
      }
  });

  it("waits for visible pending checks before a BLOCKED refusal", async () => {
    {
      const row = await readSnapshot({
        reader: fakeReader({ facts: { mergeStateStatus: "BLOCKED" },
          checks: [pendingCheck()],
          commitRollups: [{ oid: "head", state: "FAILURE" }],
        }),
        reviewerChecks: [], context: context(3), allowDraft: false,
      });

      expect(classifyPr(row)).toMatchObject({ kind: "waiting" });
    }
  });

  it("allows CLEAN and keeps BEHIND in the conflict tier", async () => {
    expect(classifyPr(await openSnapshot(context(4)))).toMatchObject({ kind: "ready" });

    const row = await openSnapshot(context(4), { facts: { mergeStateStatus: "BEHIND" } });
    expect(classifyPr(row)).toMatchObject({ kind: "blocker", blocker: { kind: "merge-conflicts" } });
    expect(renderPretty({ schemaVersion: 1, sequence: 1, observedAt: "now", mode: "single",
      kind: "STATUS", terminal: true, exitCode: 0, reason: "status-only", rows: [row],
    })).toContain("⚠️ behind");
  });

  it("turns a clean visible list plus GitHub refusal into an explicit CI blocker", async () => {
    const reader = fakeReader({
      facts: { mergeStateStatus: "BLOCKED" },
      checks: [passingCheck()],
      commitRollups: [{ oid: "head", state: "FAILURE" }],
    });

    const snapshot = await readSnapshot({
      reviewerChecks: [],
      reader,
      context: context(1),

      allowDraft: false,
    });

    expect(snapshot.kind).toBe("open");
    if (snapshot.kind !== "open") throw new Error("expected open snapshot");

    expect(snapshot.ci.kind).toBe("ci-github-rejected");
    expect(classifyPr(snapshot)).toMatchObject({
      kind: "blocker",
      blocker: { kind: "failing-checks" },
    });
  });
});

describe("snapshot query planning", () => {
  it("gets pending checks and history in one read", async () => {
    const reader = fakeReader({
      checks: [pendingCheck()],
      commitRollups: [{ oid: "old-head", state: "SUCCESS" }, { oid: "head", state: "PENDING" }],
    });

    const snapshot = await readSnapshot({
      reviewerChecks: [],
      reader,
      context: context(2),

      allowDraft: false,
    });

    expect(snapshot.kind).toBe("open");
    if (snapshot.kind !== "open") throw new Error("expected open snapshot");

    expect(snapshot.ci.kind).toBe("ci-pending");
    expect(snapshot.ci.hadPreviousPassingCi).toBe(true);
    expect(reader.calls).toEqual(["read"]);
  });

  it("gets settled and failed checks with rollups in one read", async () => {
    const settled = fakeReader();
    await readSnapshot({
      reviewerChecks: [],
      reader: settled,
      context: context(3),

      allowDraft: false,
    });

    expect(settled.calls).toEqual(["read"]);

    const failed = fakeReader({
      checks: [failedCheck()],
    });

    await readSnapshot({
      reviewerChecks: [],
      reader: failed,
      context: context(4),

      allowDraft: false,
    });

    expect(failed.calls).toEqual(["read"]);
  });

  it("short-circuits merged rows before threads and checks", async () => {
    const reader = fakeReader({
      facts: { state: "MERGED", mergedAt: "2026-07-26T00:00:00Z" },
    });

    expect(
      (
        await readSnapshot({
          reviewerChecks: [],
          reader,
          context: context(5),

          allowDraft: false,
        })
      ).kind
    ).toBe("merged");

    expect(reader.calls).toEqual(["read"]);
  });
});

it("scans stacks tier-major so an upstack conflict outranks frontier CI", async () => {
  const frontier = await readSnapshot({
    reviewerChecks: [],
    reader: fakeReader({
      checks: [failedCheck()],
      commitRollups: [{ oid: "head", state: "FAILURE" }],
    }),
    context: context(10),

    allowDraft: false,
  });

  const upstack = await readSnapshot({
    reviewerChecks: [],
    reader: fakeReader({ facts: { mergeable: "CONFLICTING" } }),
    context: context(11),

    allowDraft: false,
  });

  const decision = selectTierMajorStackDecision([frontier, upstack]);
  expect(decision).toMatchObject({
    kind: "blocker",
    blocker: { kind: "merge-conflicts", pr: { number: 11 } },
  });
});

it("attributes a stack wait to the PR whose checks are pending, not the bottom", async () => {
  const readyBottom = await readSnapshot({
    reviewerChecks: [],
    reader: fakeReader(),
    context: context(20),

    allowDraft: false,
  });

  const pendingUpstack = await readSnapshot({
    reviewerChecks: [],
    reader: fakeReader({
      checks: [pendingCheck("upstack-build")],
    }),
    context: context(21),

    allowDraft: false,
  });

  const decision = selectTierMajorStackDecision([readyBottom, pendingUpstack]);
  expect(decision).toMatchObject({
    kind: "waiting",
    frontier: { number: 21 },
    pending: [{ name: "upstack-build" }],
  });
});

it("waits on a draft while checks are pending, then reports the draft gate", async () => {
  const pending = await readSnapshot({
    reviewerChecks: [],
    reader: fakeReader({
      facts: { isDraft: true },
      checks: [pendingCheck()],
    }),
    context: context(12),

    allowDraft: false,
  });

  expect(classifyPr(pending).kind).toBe("waiting");

  const settled = await readSnapshot({
    reviewerChecks: [],
    reader: fakeReader({ facts: { isDraft: true } }),
    context: context(12),

    allowDraft: false,
  });

  expect(classifyPr(settled)).toMatchObject({
    kind: "blocker",
    blocker: { kind: "merge-gate", reason: "draft-pr" },
  });
});

describe("queued-stack cadence", () => {
  it("drops a sweep head only after its snapshot succeeds", async () => {
    const queue = [
      context(20),
      context(21),
      context(22),
    ] satisfies NonEmpty<PrContext>;

    let state = createQueueState(queue, 0);
    const first = await openSnapshot(queue[0]);
    state = applyQueueSnapshot(state, first, 0, options).state;
    expect(state.work).toMatchObject({
      kind: "whole-stack-sweep",
      remaining: [{ number: 21 }, { number: 22 }],
    });

    const second = await openSnapshot(queue[1]);
    state = applyQueueSnapshot(state, second, 60, options).state;
    expect(state.work).toMatchObject({
      kind: "whole-stack-sweep",
      remaining: [{ number: 22 }],
    });
  });

  it("resumes the sweep at the PR whose read failed", async () => {
    const middle = context(21);
    const base = fakeReader();
    let failNext = true;
    const timeline: string[] = [];
    const reader = {
      ...base,
      async read(pr: PrContext) {
        if (pr.number === middle.number && failNext) {
          failNext = false;
          timeline.push(`fail:${pr.number}`);
          throw new WatcherQueryError({
            kind: "command-exit",
            retryable: true,
            detail: "rate limited",
            code: 1,
          });
        }

        timeline.push(`read:${pr.number}`);
        return base.read(pr);
      },
    } satisfies GitHubReader;

    let now = 0;
    let sleeps = 0;
    const running = runQueued({
      dependencies: {
        reader,
        reviewerChecks: [],
        clock: {
          now: () => now,
          observedAt: () => "2026-07-26T00:00:00.000Z",
          async sleep(seconds) {
            timeline.push("sleep");
            now += seconds;
            sleeps += 1;
            if (sleeps === 2) throw new Error("stop after resume proof");
          },
        },
        emit(verdict) {
          timeline.push(`emit:${verdict.kind}`);
        },
      },
      contexts: [context(20), middle, context(22)],
      options,
    });

    await expect(running).rejects.toThrow("stop after resume proof");
    expect(timeline).toEqual([
      "emit:QUEUE",
      "read:20",
      "fail:21",
      "emit:RETRY",
      "sleep",
      "read:21",
      "read:22",
      "emit:STATUS",
      "emit:WAITING",
      "sleep",
    ]);
  });

  it("emits a completed sweep only after its final successful snapshot", async () => {
    const queue = [context(30), context(31)] satisfies NonEmpty<PrContext>;
    let state = createQueueState(queue, 0);
    const first = applyQueueSnapshot(
      state,
      await openSnapshot(queue[0]),
      0,
      options
    );

    expect(first.completedSweepRows).toBeNull();
    state = first.state;
    const second = applyQueueSnapshot(
      state,
      await openSnapshot(queue[1]),
      5,
      options
    );

    expect(
      second.completedSweepRows?.map((row) => Number(row.context.number))
    ).toEqual([30, 31]);

    expect(second.state.nextSweepAt).toBe(305);
  });

  it("ADVANCE continues directly to the new frontier without sleeping", async () => {
    const one = context(40);
    const two = context(41);
    const base = fakeReader();
    const reads = new Map<number, number>();
    const timeline: string[] = [];
    const reader = {
      ...base,
      async read(pr: PrContext) {
        timeline.push(`read:${pr.number}`);
        const read = await base.read(pr);
        const facts = read.facts;
        const count = (reads.get(pr.number) ?? 0) + 1;
        reads.set(pr.number, count);
        return pr.number === one.number && count > 1
          ? {
              ...read,
              facts: { ...facts, state: "MERGED" as const,
              mergedAt: "2026-07-26T00:00:00Z" },
            }
          : read;
      },
    } satisfies GitHubReader;

    let now = 0;
    let sleeps = 0;
    const emitted: ProgressVerdict[] = [];
    const running = runQueued({
      dependencies: {
        reader,
        reviewerChecks: [],
        clock: {
          now: () => now,
          observedAt: () => "2026-07-26T00:00:00.000Z",
          async sleep(seconds) {
            timeline.push("sleep");
            now += seconds;
            sleeps += 1;
            if (sleeps === 2) throw new Error("stop after advance proof");
          },
        },
        emit(verdict) {
          emitted.push(verdict);
          timeline.push(`emit:${verdict.kind}`);
        },
      },
      contexts: [one, two],
      options,
    });

    await expect(running).rejects.toThrow("stop after advance proof");
    expect(emitted.some((event) => event.kind === "ADVANCE")).toBe(true);
    const firstSleep = timeline.indexOf("sleep");
    expect(timeline.slice(firstSleep, firstSleep + 5)).toEqual([
      "sleep",
      "read:40",
      "emit:ADVANCE",
      "read:41",
      "emit:WAITING",
    ]);
  });

  it("times out with the new frontier when the deadline passes during the read that advanced", async () => {
    const one = context(40);
    const two = context(41);
    const base = fakeReader();
    const reads = new Map<number, number>();
    let now = 0;
    const reader = {
      ...base,
      async read(pr: PrContext) {
        const read = await base.read(pr);
        const count = (reads.get(pr.number) ?? 0) + 1;
        reads.set(pr.number, count);
        if (pr.number !== one.number || count === 1) {
          now += 1;
          return read;
        }

        now += 10;
        return { ...read, facts: { ...read.facts, state: "MERGED" as const, mergedAt: "2026-07-26T00:00:00Z" } };
      },
    } satisfies GitHubReader;

    const emitted: ProgressVerdict[] = [];
    const verdict = await runQueued({
      dependencies: {
        reader,
        reviewerChecks: [],
        clock: { now: () => now, observedAt: () => "2026-07-26T00:00:00.000Z", async sleep(seconds) { now += seconds; } },
        emit(event) { emitted.push(event); },
      },
      contexts: [one, two],
      options: { ...options, interval: 1, timeout: 10 },
      startedAt: 0,
    });

    expect(emitted.at(-1)).toMatchObject({ kind: "ADVANCE", frontier: { number: 41 } });
    expect(verdict).toMatchObject({ kind: "TIMEOUT", exitCode: 5,
      reason: { kind: "queued-stack", frontier: { number: 41 }, unmergedCount: 1 },
    });
  });

  it("times out with the queue frontier when the deadline passes during the first sweep", async () => {
    const base = fakeReader();
    let now = 0;
    const reader = { ...base, async read(pr: PrContext) {
      now += 10;
      return base.read(pr);
    } } satisfies GitHubReader;

    const verdict = await runQueued({
      dependencies: {
        reader,
        reviewerChecks: [],
        clock: { now: () => now, observedAt: () => "2026-07-26T00:00:00.000Z", async sleep(seconds) { now += seconds; } },
        emit() {},
      },
      contexts: [context(40), context(41)],
      options: { ...options, timeout: 10 },
      startedAt: 0,
    });

    expect(verdict).toMatchObject({ kind: "TIMEOUT", exitCode: 5,
      reason: { kind: "queued-stack", frontier: { number: 40 }, unmergedCount: 2 },
    });
  });

  it("reports every merged PR when a sweep skips a frontier", async () => {
    const queue = [
      context(60),
      context(61),
      context(62),
    ] satisfies NonEmpty<PrContext>;

    const base = fakeReader();
    const reads = new Map<number, number>();
    const reader = {
      ...base,
      async read(pr: PrContext) {
        const read = await base.read(pr);
        const facts = read.facts;
        const count = (reads.get(pr.number) ?? 0) + 1;
        reads.set(pr.number, count);
        return pr.number !== queue[2].number && count > 1
          ? {
              ...read,
              facts: { ...facts, state: "MERGED" as const,
              mergedAt: "2026-07-26T00:00:00Z" },
            }
          : read;
      },
    } satisfies GitHubReader;

    let now = 0;
    let sleeps = 0;
    const emitted: ProgressVerdict[] = [];
    const running = runQueued({
      dependencies: {
        reader,
        reviewerChecks: [],
        clock: {
          now: () => now,
          observedAt: () => "2026-07-26T00:00:00.000Z",
          async sleep() {
            now += options.sweepInterval;
            sleeps += 1;
            if (sleeps === 2) throw new Error("stop after advance proof");
          },
        },
        emit(verdict) {
          emitted.push(verdict);
        },
      },
      contexts: queue,
      options,
    });

    await expect(running).rejects.toThrow("stop after advance proof");
    expect(
      emitted.some(
        (event) =>
          event.kind === "WAITING" && event.frontier.number === queue[0].number
      )
    ).toBe(true);

    const advance = emitted.find((event) => event.kind === "ADVANCE");
    if (advance?.kind !== "ADVANCE") throw new Error("expected advance");

    expect(advance.merged.map((pr) => Number(pr.context.number))).toEqual(
      [60, 61]
    );

    expect(advance.frontier.number).toBe(queue[2].number);
    expect(advance.remaining).toBe(1);
    expect(
      JSON.parse(JSON.stringify(advance)).merged.map(
        (pr: { context: PrContext }) => Number(pr.context.number)
      )
    ).toEqual([60, 61]);

    expect(renderPretty(advance)).toBe(
      "ADVANCE: merged #60,#61; next=#62; remaining=1\n"
    );
  });

  it("completes with every PR when the whole queue merges between polls", async () => {
    const queue = [
      context(70),
      context(71),
      context(72),
    ] satisfies NonEmpty<PrContext>;

    const base = fakeReader();
    const reads = new Map<number, number>();
    const reader = {
      ...base,
      async read(pr: PrContext) {
        const read = await base.read(pr);
        const facts = read.facts;
        const count = (reads.get(pr.number) ?? 0) + 1;
        reads.set(pr.number, count);
        return count > 1
          ? {
              ...read,
              facts: { ...facts, state: "MERGED" as const,
              mergedAt: "2026-07-26T00:00:00Z" },
            }
          : read;
      },
    } satisfies GitHubReader;

    let now = 0;
    const emitted: ProgressVerdict[] = [];
    const verdict = await runQueued({
      dependencies: {
        reader,
        reviewerChecks: [],
        clock: {
          now: () => now,
          observedAt: () => "2026-07-26T00:00:00.000Z",
          async sleep() {
            now += options.sweepInterval;
          },
        },
        emit(event) {
          emitted.push(event);
        },
      },
      contexts: queue,
      options,
    });

    expect(
      emitted.some(
        (event) =>
          event.kind === "WAITING" && event.frontier.number === queue[0].number
      )
    ).toBe(true);

    expect(verdict.kind).toBe("COMPLETE");
    if (verdict.kind !== "COMPLETE") throw new Error("expected complete");

    expect(verdict.merged.map((pr) => Number(pr.context.number))).toEqual(
      [70, 71, 72]
    );

    expect(renderPretty(verdict)).toBe(
      "COMPLETE: queued stack merged (3 PRs): #70,#71,#72\n"
    );
  });

  it("waits without reporting a merged PR again after advance", async () => {
    const queue = [
      context(80),
      context(81),
      context(82),
    ] satisfies NonEmpty<PrContext>;

    let state = createQueueState(queue, 0);
    for (const pr of queue)
      state = applyQueueSnapshot(state, await openSnapshot(pr), 0, options)
        .state;

    const first = evaluateQueue(state, 0, options);
    expect(first.kind).toBe("waiting");
    if (first.kind !== "waiting") throw new Error("expected waiting");

    state = planQueue(first.state, options.sweepInterval);

    for (const pr of queue) {
      const snapshot = await readSnapshot({
        reviewerChecks: [],
        reader: fakeReader({
          facts:
            pr.number === queue[2].number
              ? {}
              : { state: "MERGED", mergedAt: "2026-07-26T00:00:00Z" },
        }),
        context: pr,

        allowDraft: false,
      });

      state = applyQueueSnapshot(
        state,
        snapshot,
        options.sweepInterval,
        options
      ).state;
    }

    const advance = evaluateQueue(state, options.sweepInterval, options);
    expect(advance.kind).toBe("advance");
    if (advance.kind !== "advance") throw new Error("expected advance");

    expect(advance.merged.map((pr) => Number(pr.context.number))).toEqual(
      [80, 81]
    );

    state = planQueue(advance.state, options.sweepInterval + options.interval);
    state = applyQueueSnapshot(
      state,
      await openSnapshot(queue[2]),
      options.sweepInterval + options.interval,
      options
    ).state;

    const again = evaluateQueue(
      state,
      options.sweepInterval + options.interval,
      options
    );

    expect(again.kind).toBe("waiting");
    if (again.kind !== "waiting") throw new Error("expected waiting");

    expect(again.frontier.number).toBe(queue[2].number);
  });

  it("deduplicates identical waits and schedules the next due sweep", async () => {
    const queue = [context(50)] satisfies NonEmpty<PrContext>;
    let state = createQueueState(queue, 0);
    state = applyQueueSnapshot(
      state,
      await openSnapshot(queue[0]),
      0,
      options
    ).state;

    const first = evaluateQueue(state, 0, options);
    expect(first.kind).toBe("waiting");
    if (first.kind !== "waiting") throw new Error("expected waiting");

    expect(first.emit).toBe(true);
    const second = evaluateQueue(first.state, 10, options);
    expect(second.kind).toBe("waiting");
    if (second.kind !== "waiting") throw new Error("expected waiting");

    expect(second.emit).toBe(false);
    expect(planQueue(second.state, 300).work?.kind).toBe("whole-stack-sweep");
  });
});

it("uses the specified retry floor and cap", () => {
  expect(queryBackoffSeconds(1, 1)).toBe(60);
  expect(queryBackoffSeconds(1, 2)).toBe(120);
  expect(queryBackoffSeconds(60, 4)).toBe(300);
});

describe("poll deadlines and whole-read refreshes", () => {
  function dependencies(reader: GitHubReader) {
    let now = 0;
    const sleeps: number[] = [];
    const emitted: ProgressVerdict[] = [];
    return {
      sleeps, emitted, advance: (seconds: number) => { now += seconds; },
      dependencies: {
        reader, reviewerChecks: [],
        clock: { now: () => now, observedAt: () => "2026-10-02T00:00:00Z", async sleep(seconds: number) {
          sleeps.push(seconds);
          now += seconds;
        } },
        emit: (event: ProgressVerdict) => { emitted.push(event); },
      },
    };
  }

  it("never reads after a pending sleep reaches the deadline in single or stack mode", async () => {
    for (const mode of ["single", "stack"] as const) {
      const reader = fakeReader({ checks: [pendingCheck()] });
      const value = dependencies(reader);
      const verdict = await runSimple({ dependencies: value.dependencies, contexts: [context(1)], mode,
        statusOnly: false, options: { ...options, timeout: 5 },
      });

      expect(verdict).toMatchObject({ kind: "TIMEOUT", reason: { kind: "pending-checks" } });
      expect(reader.calls).toEqual(["read"]);
      expect(value.sleeps).toEqual([5]);
    }
  });

  it("keeps the queued-stack timeout reason without reading again after its sleep", async () => {
    for (const checks of [[pendingCheck()], [passingCheck()]]) {
      const reader = fakeReader({ checks });
      const value = dependencies(reader);
      const verdict = await runQueued({ dependencies: value.dependencies, contexts: [context(1)],
        options: { ...options, timeout: 5 },
      });

      expect(verdict).toMatchObject({ kind: "TIMEOUT", reason: { kind: "queued-stack", frontier: { number: 1 }, unmergedCount: 1 } });
      expect(reader.calls).toEqual(["read"]);
      expect(value.sleeps).toEqual([5]);
    }
  });

  it("clamps retry backoff and prefers TIMEOUT over a query-error limit at the deadline", async () => {
    for (const spent of [false, true]) {
      const base = fakeReader();
      const reader = { ...base, async read() {
        if (spent) value.advance(5);
        throw new WatcherQueryError({ kind: "command-exit", retryable: true, detail: "failed", code: 1 });
      } };
      const value = dependencies(reader);
      const verdict = await runSimple({ dependencies: value.dependencies, contexts: [context(1)], mode: "single",
        statusOnly: false, options: { ...options, timeout: 5, maxQueryErrors: spent ? 1 : 5 },
      });

      expect(verdict).toMatchObject({ kind: "TIMEOUT", reason: { kind: "status-unavailable" } });
      expect(value.sleeps).toEqual(spent ? [] : [5]);
      expect(value.emitted.map((event) => event.kind)).toEqual(spent ? [] : ["RETRY"]);
    }
  });

  it("replaces facts, checks, threads and history on an UNKNOWN refresh", async () => {
    const first = fakeReader({ facts: { mergeStateStatus: "UNKNOWN", headRefOid: "old" } });
    const second = fakeReader({ facts: { headRefOid: "new" }, checks: [pendingCheck("new-ci")],
      commitRollups: [{ oid: "old", state: "SUCCESS" }, { oid: "new", state: "PENDING" }],
      threads: [{ id: "new-thread", firstComment: null, isReviewBot: false, reviewBotPasses: 0 }],
    });
    let reads = 0;
    const reader = { ...first, async read(pr: PrContext) { return ++reads === 1 ? first.read(pr) : second.read(pr); } };
    const value = dependencies(reader);
    const row = await readSnapshot({ reader, context: context(1), reviewerChecks: [], allowDraft: false,
      clock: value.dependencies.clock, remaining: () => 10,
    });

    expect(row).toMatchObject({ facts: { headRefOid: "new" }, threads: [{ id: "new-thread" }],
      ci: { kind: "ci-pending", pending: [{ name: "new-ci" }], hadPreviousPassingCi: true },
    });
    expect(reads).toBe(2);
    expect(value.sleeps).toEqual([2]);
  });

  it("skips UNKNOWN refreshes when checks, threads, conflicts, a draft or the remaining budget decide the row", async () => {
    const cases: FakeReaderOptions[] = [
      { checks: [pendingCheck()] },
      { checks: [failedCheck()] },
      { threads: [{ id: "thread", firstComment: null, isReviewBot: false, reviewBotPasses: 0 }] },
      { facts: { mergeable: "CONFLICTING" } },
      { facts: { isDraft: true } },
      {},
    ];
    for (const item of cases) {
      const reader = fakeReader({ ...item, facts: { mergeStateStatus: "UNKNOWN", ...item.facts } });
      const value = dependencies(reader);
      await readSnapshot({ reader, context: context(1), reviewerChecks: [], allowDraft: false,
        clock: value.dependencies.clock, remaining: () => item === cases.at(-1) ? 2 : 10,
      });

      expect(reader.calls).toEqual(["read"]);
      expect(value.sleeps).toEqual([]);
    }
  });
});

it("blocks on an unresolved review thread even when everything else is clean", async () => {
  const snapshot = await readSnapshot({
    reviewerChecks: [],
    reader: fakeReader({
      checks: [passingCheck()],
      commitRollups: [{ oid: "head", state: "SUCCESS" }],
      threads: [
        {
          id: "t1",
          isReviewBot: true,
          reviewBotPasses: 1,
          firstComment: {
            authorLogin: "rev[bot]",
            body: "Confidence score: 7. Unguarded viewer.",
            path: "a.ts",
            line: 3,
            createdAt: "2026-08-31T10:00:00Z",
          },
        },
      ],
    }),
    context: context(20),

    allowDraft: false,
  });

  expect(selectTierMajorStackDecision([snapshot])).toMatchObject({
    kind: "blocker",
    blocker: { kind: "review-threads", pr: { number: 20 } },
  });
});

it("detects pending checks from reviewer declarations", async () => {
  for (const [name, expected] of [
    ["CI: TESTBOT Review", true],
    ["Unlisted bot", false],
    ["Security Review", true],
  ] as const) {
    const snapshot = await readSnapshot({
      reader: fakeReader({
        checks: [pendingCheck(name)],
      }),
      reviewerChecks: ["TestBot Review"],
      context: context(90),

      allowDraft: false,
    });

    expect(snapshot.kind).toBe("open");
    if (snapshot.kind !== "open") throw new Error("expected open snapshot");

    expect(snapshot.reviewAutomationRunning).toBe(expected);
  }
});

it("detects a pending declared reviewer check", async () => {
  const snapshot = await readSnapshot({
    reader: fakeReader({
      checks: [pendingCheck("CodeRabbit")],
    }),
    reviewerChecks: reviewerDeclarations(join(import.meta.dir, "../../skills")).checks,
    context: context(91),

    allowDraft: false,
  });

  expect(snapshot.kind).toBe("open");
  if (snapshot.kind !== "open") throw new Error("expected open snapshot");

  expect(snapshot.reviewAutomationRunning).toBe(true);
});


describe("merge state polling", () => {
  function dependencies(reader: GitHubReader, emitted: ProgressVerdict[]) {
    let now = 0;

    return {
      reader,
      reviewerChecks: [],
      clock: {
        now: () => now,
        observedAt: () => "2026-10-01T00:00:00Z",
        async sleep(seconds: number) { now += seconds; },
      },
      emit: (verdict: ProgressVerdict) => { emitted.push(verdict); },
    };
  }

  it("retries UNKNOWN then returns READY when CLEAN in single mode", async () => {
    const base = fakeReader();
    let reads = 0;
    const emitted: ProgressVerdict[] = [];
    const reader = { ...base, async read(pr: PrContext) {
      const read = await base.read(pr);
        const facts = read.facts;
      return { ...read, facts: { ...facts, mergeStateStatus: reads++ === 0 ? "UNKNOWN" as const : "CLEAN" as const } };
    } };

    const verdict = await runSimple({ dependencies: dependencies(reader, emitted),
      contexts: [context(1)], mode: "single", statusOnly: false, options,
    });

    expect(emitted).toEqual([]);
    expect(verdict).toMatchObject({ kind: "READY", exitCode: 0, sequence: 1 });
  });

  it("prints STATUS for UNKNOWN without classifying", async () => {
    const emitted: ProgressVerdict[] = [];
    const reader = fakeReader({ facts: { mergeStateStatus: "UNKNOWN" } });

    const verdict = await runSimple({ dependencies: dependencies(reader, emitted),
      contexts: [context(1)], mode: "single", statusOnly: true, options,
    });

    expect(verdict).toMatchObject({ kind: "STATUS", exitCode: 0 });
    expect(emitted).toEqual([]);
  });

  it("exhausts UNKNOWN retries as a status-query blocker", async () => {
    const emitted: ProgressVerdict[] = [];
    const reader = fakeReader({ facts: { mergeStateStatus: "UNKNOWN" } });

    const verdict = await runSimple({ dependencies: dependencies(reader, emitted),
      contexts: [context(1)], mode: "single", statusOnly: false,
      options: { ...options, maxQueryErrors: 2 },
    });

    expect(emitted.map((event) => event.kind)).toEqual(["RETRY"]);
    expect(verdict).toMatchObject({ kind: "BLOCKER", exitCode: 7,
      blocker: { kind: "status-query", failure: { kind: "merge-state-unknown" } },
    });
  });

  it("retries queued evaluation before emitting a merge-queue wait", async () => {
    const base = fakeReader();
    let reads = 0;
    const emitted: ProgressVerdict[] = [];
    const reader = { ...base, async read(pr: PrContext) {
      const read = await base.read(pr);
        const facts = read.facts;

      reads++;
      if (reads === 1) return { ...read, facts: { ...facts, mergeStateStatus: "UNKNOWN" as const } };
      if (reads === 2) return read;
      return { ...read, facts: { ...facts, state: "MERGED" as const, mergedAt: "now" } };
    } };

    const verdict = await runQueued({ dependencies: dependencies(reader, emitted), contexts: [context(1)], options });

    expect(emitted.map((event) => event.kind)).toEqual(["QUEUE", "STATUS", "WAITING"]);
    expect(verdict).toMatchObject({ kind: "COMPLETE", exitCode: 0 });
  });

  it("does not emit a merge-queue wait for an UNKNOWN frontier with pending upstack", async () => {
    const queue = [context(1), context(2)] satisfies NonEmpty<PrContext>;
    let state = createQueueState(queue, 0);
    state = applyQueueSnapshot(state, await openSnapshot(queue[0], { facts: { mergeStateStatus: "UNKNOWN" } }), 0, options).state;
    state = applyQueueSnapshot(state, await openSnapshot(queue[1], { checks: [pendingCheck()] }), 0, options).state;

    expect(() => evaluateQueue(state, 0, options)).toThrow(WatcherQueryError);
  });

  it("reports a CLEAN frontier merge-ready while an upstack PR is still UNKNOWN", async () => {
    const queue = [context(1), context(2)] satisfies NonEmpty<PrContext>;
    let state = createQueueState(queue, 0);
    state = applyQueueSnapshot(state, await openSnapshot(queue[0]), 0, options).state;
    state = applyQueueSnapshot(state, await openSnapshot(queue[1], { facts: { mergeStateStatus: "UNKNOWN" } }), 0, options).state;

    expect(evaluateQueue(state, 0, options)).toMatchObject({
      kind: "waiting",
      frontier: { number: 1 },
      reason: { kind: "merge-queue" },
    });
  });

  it("exhausts queued UNKNOWN retries even when each retry sweeps multiple PRs", async () => {
    const emitted: ProgressVerdict[] = [];
    const deps = dependencies(fakeReader({ facts: { mergeStateStatus: "UNKNOWN" } }), emitted);
    const sleep = deps.clock.sleep;
    let sleeps = 0;
    deps.clock.sleep = async (seconds) => {
      if (++sleeps > 13) throw new Error("retry budget did not stop the queue");
      await sleep(seconds);
    };

    const verdict = await runQueued({ dependencies: deps, contexts: [context(1), context(2)],
      options: { ...options, maxQueryErrors: 2, sweepInterval: 1 },
    });

    expect(verdict).toMatchObject({ kind: "BLOCKER", exitCode: 7,
      blocker: { kind: "status-query", failures: 2, failure: { kind: "merge-state-unknown" } },
    });

    expect(emitted.filter((event) => event.kind === "RETRY")).toHaveLength(1);
    expect(emitted.some((event) => event.kind === "WAITING")).toBe(false);
  });
});

describe("review findings on strict readiness", () => {
  const gateCheck = (): ReturnType<typeof passingCheck> => ({
    ...passingCheck("Code Review Gate"),
    kind: "code-review-gate",
    name: "Code Review Gate",
    reportedState: "PENDING",
  });

  const blockedOnApprovalGate: FakeReaderOptions = {
    facts: { mergeStateStatus: "BLOCKED", reviewDecision: null },
    checks: [passingCheck(), gateCheck()],
    commitRollups: [{ oid: "head", state: "PENDING" }],
  };

  function clockedDependencies(reader: GitHubReader, emitted: ProgressVerdict[]) {
    let now = 0;

    return {
      reader,
      reviewerChecks: [],
      clock: {
        now: () => now,
        observedAt: () => "2026-10-01T00:00:00Z",
        async sleep(seconds: number) { now += seconds; },
      },
      emit: (verdict: ProgressVerdict) => { emitted.push(verdict); },
    };
  }

  it("treats a pending Code Review Gate on a BLOCKED PR as an owner approval wait", async () => {
    const row = await openSnapshot(context(1), blockedOnApprovalGate);

    expect(classifyPr(row)).toMatchObject({
      kind: "blocker",
      blocker: { kind: "merge-gate", reason: "review-required" },
    });
  });

  it("ends a single watch on the approval gate with exit 6 and no retry", async () => {
    const emitted: ProgressVerdict[] = [];
    const verdict = await runSimple({
      dependencies: clockedDependencies(fakeReader(blockedOnApprovalGate), emitted),
      contexts: [context(1)],
      mode: "single",
      statusOnly: false,
      options,
    });

    expect(emitted).toEqual([]);
    expect(verdict).toMatchObject({ kind: "BLOCKER", exitCode: 6 });
  });

  it("ignores an upstack merge state refusal in queued mode but not an upstack failing rollup", async () => {
    const queue = [context(1), context(2)] satisfies NonEmpty<PrContext>;
    const withUpstack = async (upstack: FakeReaderOptions) => {
      let state = createQueueState(queue, 0);
      state = applyQueueSnapshot(state, await openSnapshot(queue[0]), 0, options).state;
      state = applyQueueSnapshot(state, await openSnapshot(queue[1], upstack), 0, options).state;
      return evaluateQueue(state, 0, options);
    };

    expect(await withUpstack({ facts: { mergeStateStatus: "BLOCKED" } })).toMatchObject({
      kind: "waiting",
      reason: { kind: "merge-queue" },
    });

    expect(await withUpstack({ facts: { mergeStateStatus: "BEHIND" } })).toMatchObject({ kind: "waiting" });

    expect(
      await withUpstack({ facts: { mergeStateStatus: "BLOCKED" }, commitRollups: [{ oid: "head", state: "FAILURE" }] }),
    ).toMatchObject({ kind: "blocker", blocker: { kind: "failing-checks" } });
  });

  it("resets the transport failure budget after a successful read", async () => {
    const base = fakeReader();
    const emitted: ProgressVerdict[] = [];
    let reads = 0;
    const reader = { ...base, async read(pr: PrContext) {
      reads++;

      if (reads === 1 || reads === 3)
        throw new WatcherQueryError({ kind: "command-exit", retryable: true, detail: "gh flaked", code: 1 });

      const read = await base.read(pr);
      return reads >= 5 ? { ...read, facts: { ...read.facts, state: "MERGED" as const, mergedAt: "now" } } : read;
    } };

    const verdict = await runQueued({
      dependencies: clockedDependencies(reader, emitted),
      contexts: [context(1), context(2)],
      options: { ...options, maxQueryErrors: 2 },
    });

    expect(verdict).not.toMatchObject({ exitCode: 7 });
  });
});

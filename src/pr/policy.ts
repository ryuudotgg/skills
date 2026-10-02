import { ChecksUnavailable, WatcherQueryError } from "./github.ts";
import type * as T from "./types.ts";
import { nonEmpty } from "./types.ts";
export function assessGitHubMerge(args: {
  readonly mergeStateStatus: T.MergeStateStatus;
  readonly headRollupState: T.RollupState;
  readonly reviewDecision: T.ReviewDecision;
  readonly approvalGatePending: boolean;
}): T.GitHubMergeAssessment {
  const { mergeStateStatus, headRollupState } = args;
  const awaitingApproval = args.reviewDecision === "REVIEW_REQUIRED" || args.approvalGatePending;
  switch (mergeStateStatus) {
    case "CLEAN":
    case "HAS_HOOKS":
    case "UNSTABLE":
    case "DRAFT":
      return { kind: "allowed", basis: "merge-state", mergeStateStatus, headRollupState };

    case "UNKNOWN":
      return { kind: "undetermined", mergeStateStatus, headRollupState };

    case "BLOCKED":
      if (headRollupState === "FAILURE" || headRollupState === "ERROR")
        return { kind: "refused", mergeStateStatus, headRollupState };

      if (awaitingApproval)
        return { kind: "review-required", mergeStateStatus, headRollupState };

      if (headRollupState === "PENDING" || headRollupState === "EXPECTED")
        return { kind: "undetermined", mergeStateStatus, headRollupState };

      return { kind: "refused", mergeStateStatus, headRollupState };

    case "BEHIND":
    case "DIRTY":
    case "CONFLICTING":
      return { kind: "refused", mergeStateStatus, headRollupState };

    default: {
      const exhaustive: never = mergeStateStatus;
      return exhaustive;
    }
  }
}
function mergeAssessment(
  commits: readonly T.CommitRollup[],
  facts: T.PullRequestFacts,
  approvalGatePending: boolean
) {
  const headRollupState =
    facts.headRefOid === null
      ? null
      : (commits.find((commit) => commit.oid === facts.headRefOid)?.state ??
        null);

  return {
    hadPreviousPassingCi: commits.some(
      (commit) => commit.oid !== facts.headRefOid && commit.state === "SUCCESS"
    ),
    github: assessGitHubMerge({
      mergeStateStatus: facts.mergeStateStatus,
      headRollupState,
      reviewDecision: facts.reviewDecision,
      approvalGatePending,
    }),
  };
}
const AUTOMATION_TOKENS = [
  "security review",
  "pr review automation",
  "review automation",
] as const;
function snapshot(read: T.PrRead, reviewerChecks: readonly string[]): T.PrSnapshot {
  const { facts, threads } = read;
  const context = facts.context;
  if (facts.state === "MERGED" || facts.mergedAt !== null)
    return { kind: "merged", context, facts };
  if (facts.state === "CLOSED") return { kind: "closed", context, facts };

  const checks = nonEmpty(read.checks);
  if (checks === null) throw new ChecksUnavailable("could not read PR checks: GraphQL rollup was empty");

  const failed = nonEmpty(checks.filter((check): check is T.FailedCheck => check.kind === "failed"));
  const pending = nonEmpty(checks.filter((check): check is T.PendingCheck => check.kind === "pending"));
  const merge = mergeAssessment(read.rollups, facts, checks.some((check) => check.kind === "code-review-gate"));
  const base = { source: "graphql-rollup" as const, all: checks, hadPreviousPassingCi: merge.hadPreviousPassingCi };
  const ci: T.CiState = failed !== null
    ? { ...base, kind: "ci-failing", failed, pending: pending ?? [], github: merge.github }
    : pending !== null
      ? { ...base, kind: "ci-pending", failed: [], pending }
      : merge.github.kind === "refused"
        ? { ...base, kind: "ci-github-rejected", failed: [], pending: [], github: merge.github }
        : { ...base, kind: "ci-clean", failed: [], pending: [], github: merge.github };

  return {
    kind: "open", context, facts, threads, ci,
    reviewAutomationRunning: checks.some((check) => check.kind === "pending" &&
      [...AUTOMATION_TOKENS, ...reviewerChecks].some((token) => check.name.toLowerCase().includes(token.toLowerCase())),
    ),
  };
}
export async function readSnapshot(args: {
  readonly reviewerChecks: readonly string[];
  readonly reader: T.GitHubReader;
  readonly context: T.PrContext;
  readonly allowDraft: boolean;
  readonly clock?: WatchClock;
  readonly remaining?: () => number;
}): Promise<T.PrSnapshot> {
  let row: T.PrSnapshot;
  for (let attempt = 0; ; attempt++) {
    if (args.remaining !== undefined && args.remaining() <= 0)
      throw new WatcherQueryError({ kind: "read-failed", retryable: true, detail: "watch timeout reached before reading PR status" });

    row = snapshot(await args.reader.read(args.context), args.reviewerChecks);
    if (
      attempt === 3 || args.clock === undefined ||
      row.kind !== "open" || row.ci.kind !== "ci-clean" || row.ci.github.kind !== "undetermined" ||
      conflictBlocker(row) !== null || threadBlocker(row) !== null || gateBlocker(row, args.allowDraft) !== null ||
      (args.remaining !== undefined && args.remaining() <= 2)
    )
      return row;

    await args.clock.sleep(2);
  }
}
const conflictBlocker = (row: T.PrSnapshot): T.MergeBlocker | null =>
  row.kind === "open" &&
  (row.facts.mergeable === "CONFLICTING" ||
    row.facts.mergeStateStatus === "DIRTY" ||
    row.facts.mergeStateStatus === "BEHIND" ||
    row.facts.mergeStateStatus === "CONFLICTING")
    ? { kind: "merge-conflicts", pr: row.context, facts: row.facts }
    : null;
function threadBlocker(row: T.PrSnapshot): T.MergeBlocker | null {
  if (row.kind !== "open") return null;

  const threads = nonEmpty(row.threads);
  return threads === null
    ? null
    : { kind: "review-threads", pr: row.context, threads };
}
const ciBlocker = (row: T.PrSnapshot): T.MergeBlocker | null =>
  row.kind === "open" &&
  (row.ci.kind === "ci-failing" || row.ci.kind === "ci-github-rejected")
    ? { kind: "failing-checks", pr: row.context, ci: row.ci }
    : null;
function gateReason(
  row: T.PrSnapshot,
  allowDraft: boolean
): T.MergeGateReason | null {
  if (row.kind === "merged") return null;
  if (row.kind === "closed") return "closed-without-merge";
  if (row.facts.isDraft && !allowDraft) return "draft-pr";
  if (row.facts.reviewDecision === "CHANGES_REQUESTED") return "changes-requested";
  if (row.kind === "open" && row.ci.kind === "ci-clean" && row.ci.github.kind === "review-required")
    return "review-required";

  return null;
}
function gateBlocker(
  row: T.PrSnapshot,
  allowDraft: boolean
): T.MergeBlocker | null {
  const reason = gateReason(row, allowDraft);
  return reason === null ||
    (reason === "draft-pr" &&
      row.kind === "open" &&
      row.ci.kind === "ci-pending")
    ? null
    : { kind: "merge-gate", pr: row.context, reason };
}
function readyContribution(
  row: T.PrSnapshot,
  allowDraft: boolean
): T.ReadyPr | T.MergedPr | null {
  if (row.kind === "merged")
    return {
      kind: "merged-pr",
      context: row.context,
      mergedAt: row.facts.mergedAt,
    };

  if (
    row.kind !== "open" ||
    row.ci.kind !== "ci-clean" ||
    row.ci.github.kind !== "allowed" ||
    row.threads.length !== 0 ||
    conflictBlocker(row) !== null ||
    gateReason(row, allowDraft) !== null
  )
    return null;

  const reviewDecision = row.facts.reviewDecision;
  if (reviewDecision === "CHANGES_REQUESTED") return null;
  return {
    kind: "ready-pr",
    context: row.context,
    proof: {
      mergeability: "clear",
      threads: [],
      ci: { ...row.ci, github: row.ci.github },
      gate: {
        state: "OPEN",
        reviewDecision,
        draft: row.facts.isDraft ? "draft-allowed" : "not-draft",
      },
    },
  };
}
function requireSettledMerge(row: T.PrSnapshot): void {
  if (row.kind !== "open" || row.ci.kind !== "ci-clean" || row.ci.github.kind !== "undetermined") return;

  throw new WatcherQueryError({
    kind: "merge-state-unknown",
    retryable: true,
    detail: `GitHub has not settled mergeStateStatus=${row.ci.github.mergeStateStatus} for #${row.context.number}`,
  });
}
export function classifyPr(
  row: T.PrSnapshot,
  allowDraft = false
): T.PrDecision {
  for (const blocker of [
    conflictBlocker(row),
    threadBlocker(row),
    ciBlocker(row),
    gateBlocker(row, allowDraft),
  ])
    if (blocker !== null) return { kind: "blocker", blocker };

  if (row.kind === "open" && row.ci.kind === "ci-pending")
    return { kind: "waiting", frontier: row.context, pending: row.ci.pending };

  requireSettledMerge(row);

  const ready = readyContribution(row, allowDraft);
  if (ready === null) throw new Error("snapshot has no classified decision");
  return ready.kind === "merged-pr"
    ? { kind: "merged", pr: ready }
    : { kind: "ready", pr: ready };
}
function mergeStateOnly(blocker: T.MergeBlocker): boolean {
  switch (blocker.kind) {
    case "merge-conflicts":
      return (
        blocker.facts.mergeable !== "CONFLICTING" &&
        blocker.facts.mergeStateStatus === "BEHIND"
      );

    case "failing-checks":
      return (
        blocker.ci.kind === "ci-github-rejected" &&
        blocker.ci.github.headRollupState !== "FAILURE" &&
        blocker.ci.github.headRollupState !== "ERROR"
      );

    case "merge-gate":
      return blocker.reason === "review-required";

    case "review-threads":
      return false;

    default: {
      const exhaustive: never = blocker;
      return exhaustive;
    }
  }
}
function stackBlocker(
  rows: T.NonEmpty<T.PrSnapshot>,
  allowDraft: boolean,
  upstack: "strict" | "frontier-only" = "strict"
): T.MergeBlocker | null {
  const counts = (blocker: T.MergeBlocker, index: number): boolean =>
    upstack === "strict" || index === 0 || !mergeStateOnly(blocker);

  for (const tier of [conflictBlocker, threadBlocker, ciBlocker])
    for (const [index, row] of rows.entries()) {
      const blocker = tier(row);
      if (blocker !== null && counts(blocker, index)) return blocker;
    }

  for (const [index, row] of rows.entries()) {
    const blocker = gateBlocker(row, allowDraft);
    if (blocker !== null && counts(blocker, index)) return blocker;
  }

  return null;
}
export function selectTierMajorStackDecision(
  rows: T.NonEmpty<T.PrSnapshot>,
  allowDraft = false
): T.StackDecision {
  const blocker = stackBlocker(rows, allowDraft);
  if (blocker !== null) return { kind: "blocker", blocker };

  for (const row of rows)
    if (row.kind === "open" && row.ci.kind === "ci-pending")
      return {
        kind: "waiting",
        frontier: row.context,
        pending: row.ci.pending,
      };

  for (const row of rows) requireSettledMerge(row);

  const prs = nonEmpty(
    rows
      .map((row) => readyContribution(row, allowDraft))
      .filter((row): row is T.ReadyPr | T.MergedPr => row !== null)
  );

  if (prs === null || prs.length !== rows.length)
    throw new Error("stack has no classified decision");

  return { kind: "clear", prs };
}
export const queryBackoffSeconds = (
  interval: number,
  failures: number
): number => Math.min(Math.max(interval, 60) * 2 ** (failures - 1), 300);
interface Envelope<M extends T.WatchMode> {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly observedAt: string;
  readonly mode: M;
}
type Payload<V> = V extends unknown
  ? Omit<V, keyof Envelope<T.WatchMode>>
  : never;
type VerdictPayload = Payload<T.WatcherVerdict>;
export interface VerdictStamp<M extends T.WatchMode = T.WatchMode> {
  <const P extends VerdictPayload>(payload: P): Envelope<M> & P;
  <const P extends VerdictPayload, M2 extends T.WatchMode>(
    payload: P,
    mode: M2
  ): Envelope<M2> & P;
}
export function verdictFactory<M extends T.WatchMode>(
  clock: WatchClock,
  mode: M
): VerdictStamp<M> {
  let sequence = 0;
  function stamp<const P extends VerdictPayload>(payload: P): Envelope<M> & P;
  function stamp<const P extends VerdictPayload, M2 extends T.WatchMode>(
    payload: P,
    mode: M2
  ): Envelope<M2> & P;

  function stamp<const P extends VerdictPayload>(
    payload: P,
    override?: T.WatchMode
  ): Envelope<T.WatchMode> & P {
    return {
      schemaVersion: 1,
      sequence: (sequence += 1),
      observedAt: clock.observedAt(),
      mode: override ?? mode,
      ...payload,
    };
  }

  return stamp;
}
function blockerVerdict(
  stamp: VerdictStamp,
  blocker: T.MergeBlocker
): T.BlockerVerdict {
  switch (blocker.kind) {
    case "merge-conflicts":
      return stamp({ kind: "BLOCKER", terminal: true, exitCode: 2, blocker });

    case "review-threads":
      return stamp({ kind: "BLOCKER", terminal: true, exitCode: 3, blocker });

    case "failing-checks":
      return stamp({ kind: "BLOCKER", terminal: true, exitCode: 4, blocker });

    case "merge-gate":
      return stamp({ kind: "BLOCKER", terminal: true, exitCode: 6, blocker });

    default: {
      const exhaustive: never = blocker;
      return exhaustive;
    }
  }
}
export function statusQueryVerdict(
  stamp: VerdictStamp,
  failures: number,
  failure: T.QueryFailure
): T.BlockerVerdict {
  return stamp({
    kind: "BLOCKER",
    terminal: true,
    exitCode: 7,
    blocker: { kind: "status-query", failures, failure },
  });
}
export interface WatchClock {
  now(): number;
  observedAt(): string;
  sleep(seconds: number): Promise<void>;
}
export interface RunDependencies {
  readonly reviewerChecks: readonly string[];
  readonly reader: T.GitHubReader;
  readonly clock: WatchClock;
  readonly emit: (verdict: T.ProgressVerdict) => void;
}
const deadlinePassed = (
  started: number,
  options: T.PollingOptions,
  now: number
): boolean => options.timeout > 0 && now - started >= options.timeout;
type StepResult<V> =
  | { readonly kind: "terminal"; readonly verdict: V }
  | {
      readonly kind: "sleep";
      readonly seconds: number;
      readonly onDeadline?: () => V;
    }
  | { readonly kind: "continue"; readonly onDeadline?: () => V };
async function pollUntilTerminal<V>(args: {
  readonly dependencies: RunDependencies;
  readonly options: T.PollingOptions;
  readonly stamp: VerdictStamp;
  readonly step: () => Promise<StepResult<V>>;
  readonly startedAt: number;
}): Promise<V | T.BlockerVerdict | T.TimeoutVerdict> {
  let queryFailures = 0;
  let unsettledReads = 0;
  const started = args.startedAt;
  let onDeadline: (() => V) | undefined;
  const unread: T.QueryFailure = { kind: "read-failed", retryable: true, detail: "watch timeout reached before reading PR status" };
  let lastFailure: T.QueryFailure = unread;
  const timeout = () => args.stamp({ kind: "TIMEOUT", terminal: true, exitCode: 5,
    reason: { kind: "status-unavailable", failure: lastFailure },
  });
  const remaining = () => args.options.timeout > 0
    ? Math.max(0, started + args.options.timeout - args.dependencies.clock.now())
    : Infinity;
  while (true) {
    if (remaining() <= 0) return onDeadline === undefined ? timeout() : onDeadline();

    let result: StepResult<V>;
    try {
      result = await args.step();
      queryFailures = 0;
      onDeadline = undefined;
      lastFailure = unread;
      if (result.kind !== "continue") unsettledReads = 0;
    } catch (error) {
      if (!(error instanceof WatcherQueryError)) throw error;

      lastFailure = error.failure;
      onDeadline = undefined;
      if (remaining() <= 0) return timeout();

      if (error.failure.kind === "merge-state-unknown") {
        queryFailures = 0;
        unsettledReads += 1;
      } else queryFailures += 1;

      const failures = error.failure.kind === "merge-state-unknown" ? unsettledReads : queryFailures;
      if (!error.failure.retryable || failures >= args.options.maxQueryErrors)
        return statusQueryVerdict(args.stamp, failures, error.failure);

      const retryInSeconds = queryBackoffSeconds(
        args.options.interval,
        failures
      );

      args.dependencies.emit(
        args.stamp({
          kind: "RETRY",
          terminal: false,
          failure: error.failure,
          consecutiveFailures: failures,
          retryInSeconds,
        })
      );

      await args.dependencies.clock.sleep(Math.min(retryInSeconds, remaining()));
      continue;
    }

    if (result.kind === "terminal") return result.verdict;

    onDeadline = result.onDeadline;
    if (result.kind === "sleep") {
      await args.dependencies.clock.sleep(Math.min(result.seconds, remaining()));
    }
  }
}
export async function runSimple(args: {
  readonly dependencies: RunDependencies;
  readonly contexts: T.NonEmpty<T.PrContext>;
  readonly mode: T.WatchMode;
  readonly statusOnly: boolean;
  readonly options: T.PollingOptions;
  readonly startedAt?: number;
}): Promise<T.TerminalVerdict> {
  const startedAt = args.startedAt ?? args.dependencies.clock.now();
  const stamp = verdictFactory(args.dependencies.clock, args.mode);
  const step = async (): Promise<StepResult<T.TerminalVerdict>> => {
    const rows: T.PrSnapshot[] = [];
    for (const context of args.contexts)
      rows.push(
        await readSnapshot({
          reviewerChecks: args.dependencies.reviewerChecks,
          reader: args.dependencies.reader,
          context,
          allowDraft: args.options.allowDraft,
          clock: args.dependencies.clock,
          remaining: () => args.options.timeout > 0 ? startedAt + args.options.timeout - args.dependencies.clock.now() : Infinity,
        })
      );

    const complete = nonEmpty(rows);
    if (complete === null) throw new Error("watch context cannot be empty");
    if (args.statusOnly)
      return {
        kind: "terminal",
        verdict: stamp({
          kind: "STATUS",
          terminal: true,
          exitCode: 0,
          reason: "status-only",
          rows: complete,
        }),
      };

    if (args.mode === "queued-stack")
      throw new Error("queued-stack requires status-only in the simple runner");

    if (args.mode === "stack")
      args.dependencies.emit(
        stamp(
          { kind: "STATUS", terminal: false, reason: "poll", rows: complete },
          args.mode
        )
      );

    const decision =
      args.mode === "single"
        ? classifyPr(complete[0], args.options.allowDraft)
        : selectTierMajorStackDecision(complete, args.options.allowDraft);

    if (decision.kind === "blocker")
      return {
        kind: "terminal",
        verdict: blockerVerdict(stamp, decision.blocker),
      };

    if (decision.kind === "ready" || decision.kind === "merged")
      return {
        kind: "terminal",
        verdict: stamp(
          {
            kind: "READY",
            terminal: true,
            exitCode: 0,
            scope: { kind: "single", pr: decision.pr },
          },
          args.mode
        ),
      };

    if (decision.kind === "clear")
      return {
        kind: "terminal",
        verdict: stamp(
          {
            kind: "READY",
            terminal: true,
            exitCode: 0,
            scope: { kind: "stack", prs: decision.prs },
          },
          args.mode
        ),
      };

    args.dependencies.emit(
      stamp({
        kind: "WAITING",
        terminal: false,
        frontier: decision.frontier,
        reason: { kind: "pending-checks", pending: decision.pending },
      })
    );

    return {
      kind: "sleep",
      seconds: args.options.interval,
      onDeadline: () =>
        stamp({
          kind: "TIMEOUT",
          terminal: true,
          exitCode: 5,
          reason: { kind: "pending-checks", pending: decision.pending },
        }),
    };
  };

  return pollUntilTerminal({
    dependencies: args.dependencies,
    options: args.options,
    stamp,
    step,
    startedAt,
  });
}
export type QueueWork =
  | {
      readonly kind: "whole-stack-sweep";
      readonly remaining: T.NonEmpty<T.PrContext>;
    }
  | { readonly kind: "frontier-poll"; readonly frontier: T.PrContext };
export interface QueueState {
  readonly queue: T.NonEmpty<T.PrContext>;
  readonly snapshots: ReadonlyMap<T.PrNumber, T.PrSnapshot>;
  readonly work: QueueWork | null;
  readonly nextSweepAt: number;
  readonly frontier: T.PrContext | null;
  readonly lastWaitKey: string | null;
  readonly startedAt: number;
}
export const createQueueState = (
  queue: T.NonEmpty<T.PrContext>,
  now: number
): QueueState => ({
  queue,
  snapshots: new Map(),
  work: { kind: "whole-stack-sweep", remaining: queue },
  nextSweepAt: now,
  frontier: null,
  lastWaitKey: null,
  startedAt: now,
});
const orderedRows = (state: QueueState): T.PrSnapshot[] =>
  state.queue.flatMap((context) => {
    const row = state.snapshots.get(context.number);
    return row === undefined ? [] : [row];
  });
const activeRows = (state: QueueState): T.PrSnapshot[] =>
  orderedRows(state).filter((row) => row.kind !== "merged");
export function planQueue(state: QueueState, now: number): QueueState {
  if (state.work !== null) return state;
  if (state.snapshots.size === 0 || now >= state.nextSweepAt) {
    const remaining = nonEmpty(
      state.queue.filter(
        (context) => state.snapshots.get(context.number)?.kind !== "merged"
      )
    );

    if (remaining !== null)
      return { ...state, work: { kind: "whole-stack-sweep", remaining } };
  }

  const frontier = activeRows(state)[0]?.context;
  return frontier === undefined
    ? state
    : { ...state, work: { kind: "frontier-poll", frontier } };
}
export interface QueueSnapshotResult {
  readonly state: QueueState;
  readonly completedSweepRows: T.NonEmpty<T.PrSnapshot> | null;
}
export function applyQueueSnapshot(
  state: QueueState,
  snapshot: T.PrSnapshot,
  now: number,
  options: T.PollingOptions
): QueueSnapshotResult {
  if (state.work === null) throw new Error("queue has no read in flight");

  const snapshots = new Map(state.snapshots);
  snapshots.set(snapshot.context.number, snapshot);
  const base = { ...state, snapshots };
  if (state.work.kind === "frontier-poll")
    return { state: { ...base, work: null }, completedSweepRows: null };

  const [head, ...tail] = state.work.remaining;
  if (head.number !== snapshot.context.number)
    throw new Error("snapshot does not match sweep head");

  const remaining = nonEmpty(tail);
  if (remaining !== null)
    return {
      state: { ...base, work: { kind: "whole-stack-sweep", remaining } },
      completedSweepRows: null,
    };

  const rows = nonEmpty(
    state.queue.flatMap((context) => {
      const row = snapshots.get(context.number);
      return row === undefined ? [] : [row];
    })
  );

  if (rows === null || rows.length !== state.queue.length)
    throw new Error("sweep completed without every snapshot");

  return {
    state: { ...base, work: null, nextSweepAt: now + options.sweepInterval },
    completedSweepRows: rows,
  };
}
export type QueueEvaluation =
  | {
      readonly kind: "complete";
      readonly state: QueueState;
      readonly merged: T.NonEmpty<T.MergedPr>;
    }
  | {
      readonly kind: "blocker";
      readonly state: QueueState;
      readonly blocker: T.MergeBlocker;
    }
  | {
      readonly kind: "advance";
      readonly state: QueueState;
      readonly merged: T.NonEmpty<T.MergedPr>;
      readonly frontier: T.PrContext;
      readonly remaining: number;
    }
  | {
      readonly kind: "timeout";
      readonly state: QueueState;
      readonly frontier: T.PrContext;
      readonly unmergedCount: number;
    }
  | {
      readonly kind: "waiting";
      readonly state: QueueState;
      readonly frontier: T.PrContext;
      readonly reason:
        | {
            readonly kind: "pending-checks";
            readonly pending: T.NonEmpty<T.PendingCheck>;
          }
        | { readonly kind: "merge-queue"; readonly unmergedCount: number };
      readonly emit: boolean;
    };
export function evaluateQueue(
  state: QueueState,
  now: number,
  options: T.PollingOptions
): QueueEvaluation {
  const active = activeRows(state);
  if (active.length === 0) {
    const merged = nonEmpty(
      orderedRows(state).flatMap((row) =>
        row.kind === "merged"
          ? [
              {
                kind: "merged-pr" as const,
                context: row.context,
                mergedAt: row.facts.mergedAt,
              },
            ]
          : []
      )
    );

    if (merged === null) throw new Error("empty queue cannot complete");
    return { kind: "complete", state, merged };
  }

  const rows = nonEmpty(active);
  if (rows === null) throw new Error("active queue cannot be empty");

  const blocker = stackBlocker(rows, options.allowDraft, "frontier-only");
  if (blocker !== null) return { kind: "blocker", state, blocker };

  const frontier = rows[0].context;
  if (state.frontier !== null && state.frontier.number !== frontier.number) {
    const previousIndex = state.queue.findIndex(
      (context) => context.number === state.frontier?.number
    );

    const nextIndex = state.queue.findIndex(
      (context) => context.number === frontier.number
    );

    const merged = nonEmpty(
      state.queue.slice(previousIndex, nextIndex).map((context) => {
        const snapshot = state.snapshots.get(context.number);
        if (snapshot?.kind !== "merged")
          throw new Error("advanced queue entry is not merged");

        return {
          kind: "merged-pr" as const,
          context,
          mergedAt: snapshot.facts.mergedAt,
        };
      })
    );

    if (merged === null) throw new Error("advance has no merged PRs");
    return {
      kind: "advance",
      state: { ...state, frontier, lastWaitKey: null },
      merged,
      frontier,
      remaining: active.length,
    };
  }

  if (deadlinePassed(state.startedAt, options, now))
    return {
      kind: "timeout",
      state: { ...state, frontier },
      frontier,
      unmergedCount: active.length,
    };

  const row = rows[0];
  requireSettledMerge(row);
  const pending =
    row.kind === "open" && row.ci.kind === "ci-pending" ? row.ci.pending : null;

  const reason =
    pending === null
      ? ({ kind: "merge-queue", unmergedCount: active.length } as const)
      : ({ kind: "pending-checks", pending } as const);

  const key =
    reason.kind === "pending-checks"
      ? `pending:${frontier.number}:${reason.pending.length}`
      : `queue:${frontier.number}:${reason.unmergedCount}`;

  return {
    kind: "waiting",
    state: { ...state, frontier, lastWaitKey: key },
    frontier,
    reason,
    emit: state.lastWaitKey !== key,
  };
}
export async function runQueued(args: {
  readonly dependencies: RunDependencies;
  readonly contexts: T.NonEmpty<T.PrContext>;
  readonly options: T.PollingOptions;
  readonly startedAt?: number;
}): Promise<T.QueueTerminalVerdict> {
  const startedAt = args.startedAt ?? args.dependencies.clock.now();
  let state = createQueueState(args.contexts, startedAt);
  const stamp = verdictFactory(args.dependencies.clock, "queued-stack");
  args.dependencies.emit(
    stamp({ kind: "QUEUE", terminal: false, queue: args.contexts })
  );

  const queueDeadline = (): (() => T.QueueTerminalVerdict) | undefined => {
    const frontier = state.frontier === null ? undefined : activeRows(state)[0]?.context;
    if (frontier === undefined) return undefined;

    const unmergedCount = activeRows(state).length;
    return () => stamp({ kind: "TIMEOUT", terminal: true, exitCode: 5,
      reason: { kind: "queued-stack", frontier, unmergedCount },
    });
  };

  const step = async (): Promise<StepResult<T.QueueTerminalVerdict>> => {
    state = planQueue(state, args.dependencies.clock.now());
    if (state.work === null) {
      const complete = evaluateQueue(
        state,
        args.dependencies.clock.now(),
        args.options
      );

      if (complete.kind !== "complete")
        throw new Error("queue has no work while active");

      return {
        kind: "terminal",
        verdict: stamp({
          kind: "COMPLETE",
          terminal: true,
          exitCode: 0,
          queue: state.queue,
          merged: complete.merged,
        }),
      };
    }

    const context =
      state.work.kind === "whole-stack-sweep"
        ? state.work.remaining[0]
        : state.work.frontier;

    const snapshot = await readSnapshot({
      reviewerChecks: args.dependencies.reviewerChecks,
      reader: args.dependencies.reader,
      context,
      allowDraft: args.options.allowDraft,
      clock: args.dependencies.clock,
      remaining: () => args.options.timeout > 0 ? startedAt + args.options.timeout - args.dependencies.clock.now() : Infinity,
    });

    const applied = applyQueueSnapshot(
      state,
      snapshot,
      args.dependencies.clock.now(),
      args.options
    );

    state = applied.state;

    if (applied.completedSweepRows !== null)
      args.dependencies.emit(
        stamp({
          kind: "STATUS",
          terminal: false,
          reason: "whole-stack-sweep",
          rows: applied.completedSweepRows,
        })
      );

    if (state.work !== null) return { kind: "continue", onDeadline: queueDeadline() };

    const evaluation = evaluateQueue(
      state,
      args.dependencies.clock.now(),
      args.options
    );

    state = evaluation.state;
    switch (evaluation.kind) {
      case "complete":
        return {
          kind: "terminal",
          verdict: stamp({
            kind: "COMPLETE",
            terminal: true,
            exitCode: 0,
            queue: state.queue,
            merged: evaluation.merged,
          }),
        };

      case "blocker":
        return {
          kind: "terminal",
          verdict: blockerVerdict(stamp, evaluation.blocker),
        };

      case "advance":
        args.dependencies.emit(
          stamp({
            kind: "ADVANCE",
            terminal: false,
            merged: evaluation.merged,
            frontier: evaluation.frontier,
            remaining: evaluation.remaining,
          })
        );

        return { kind: "continue", onDeadline: queueDeadline() };

      case "timeout":
        return {
          kind: "terminal",
          verdict: stamp({
            kind: "TIMEOUT",
            terminal: true,
            exitCode: 5,
            reason: {
              kind: "queued-stack",
              frontier: evaluation.frontier,
              unmergedCount: evaluation.unmergedCount,
            },
          }),
        };

      case "waiting":
        if (evaluation.emit)
          args.dependencies.emit(
            stamp({
              kind: "WAITING",
              terminal: false,
              frontier: evaluation.frontier,
              reason: evaluation.reason,
            })
          );

        return { kind: "sleep", seconds: args.options.interval, onDeadline: queueDeadline() };

      default: {
        const exhaustive: never = evaluation;
        return exhaustive;
      }
    }
  };

  return pollUntilTerminal({
    dependencies: args.dependencies,
    options: args.options,
    stamp,
    step,
    startedAt,
  });
}

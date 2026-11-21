import type { RunDependencies, WatchClock } from "./policy.ts";
import type {
  BaseComparison,
  BaseReader,
  Check,
  CommitRollup,
  GitHubReader,
  OpenPullRequest,
  PrContext,
  ProgressVerdict,
  PullRequestFacts,
  Repository,
  ReviewThread,
} from "./types.ts";
import { parsePrNumber } from "./types.ts";

export interface FakeReaderOptions {
  readonly facts?: Partial<Omit<PullRequestFacts, "context">>;
  readonly checks?: readonly Check[];
  readonly threads?: readonly ReviewThread[];
  readonly commitRollups?: readonly CommitRollup[];
  readonly openPullRequests?: readonly OpenPullRequest[];
  readonly origin?: Repository | null;
  readonly current?: PrContext;
  readonly base?: BaseComparison;
  readonly changedFiles?: readonly string[];
}

export function passingCheck(name = "ci"): Check {
  return {
    kind: "passed",
    name,
    reportedState: "SUCCESS",
    description: "",
    link: "",
    workflow: "",
  };
}

export function pendingCheck(name = "ci"): Check {
  return {
    kind: "pending",
    name,
    reportedState: "PENDING",
    description: "",
    link: "",
    workflow: "",
  };
}

export function failedCheck(name = "ci"): Check {
  return {
    kind: "failed",
    name,
    reportedState: "FAILURE",
    description: "",
    link: "",
    workflow: "",
  };
}

export function fakeReader(
  options: FakeReaderOptions = {},
): GitHubReader & BaseReader & { readonly calls: readonly string[] } {
  const calls: string[] = [];
  const context = options.current ?? {
    owner: "owner",
    repo: "repo",
    number: parsePrNumber(1),
  };

  const defaults: PullRequestFacts = {
    context,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    headRefOid: "head",
    headRefName: "feature",
    baseRefName: "main",
    state: "OPEN",
    mergedAt: null,
    isDraft: false,
    autoMerge: null,
    queued: false,
  };

  return {
    calls,
    async originRepo() {
      calls.push("originRepo");
      return options.origin === undefined ? { owner: "owner", repo: "repo" } : options.origin;
    },
    async currentPr(pr) {
      calls.push("currentPr");
      return { ...context, number: pr ?? context.number };
    },
    async read(requested) {
      calls.push("read");
      return {
        facts: { ...defaults, ...options.facts, context: requested },
        checks: options.checks ?? [passingCheck()],
        threads: options.threads ?? [],
        rollups: options.commitRollups ?? [{ oid: "head", state: "SUCCESS" }],
      };
    },
    async openPullRequests() {
      calls.push("openPullRequests");
      return options.openPullRequests ?? [];
    },
    async compareBase() {
      calls.push("compareBase");
      return options.base ?? { behindBy: 0, files: [] };
    },
    async changedFiles() {
      calls.push("changedFiles");
      return options.changedFiles ?? [];
    },
  };
}

export function fakeClock() {
  let now = 0;
  const sleeps: number[] = [];
  const clock: WatchClock = {
    now: () => now,
    observedAt: () => "2026-10-02T00:00:00Z",
    async sleep(seconds) {
      sleeps.push(seconds);
      now += seconds;
    },
  };

  const advance = (seconds: number) => {
    now += seconds;
  };

  return { clock, sleeps: sleeps as readonly number[], advance };
}

export function fakeDependencies(reader: GitHubReader, emitted: ProgressVerdict[] = []) {
  const { clock, sleeps, advance } = fakeClock();
  const dependencies: RunDependencies = {
    reader,
    reviewerChecks: [],
    clock,
    emit: (verdict) => {
      emitted.push(verdict);
    },
  };

  return { dependencies, emitted, sleeps, advance };
}

import type {
  Check,
  CommitRollup,
  GitHubReader,
  OpenPullRequest,
  PrContext,
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
): GitHubReader & { readonly calls: readonly string[] } {
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
  };
}

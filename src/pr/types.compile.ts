import { parsePrNumber } from "./types.ts";
import type { CiClean, GitHubMergeAllowed, PrContext, ReadyPr, TerminalVerdict } from "./types.ts";

type ReadyVerdict = Extract<TerminalVerdict, { readonly kind: "READY" }>;

const context = {
  owner: "octocat",
  repo: "hello-world",
  number: parsePrNumber(123),
} satisfies PrContext;
const cleanCi = {
  kind: "ci-clean",
  source: "graphql-rollup",
  all: [
    {
      kind: "passed",
      name: "ci",
      reportedState: "SUCCESS",
      description: "",
      link: "",
      workflow: "",
    },
  ],
  failed: [],
  pending: [],
  hadPreviousPassingCi: false,
  github: {
    kind: "allowed",
    basis: "merge-state",
    mergeStateStatus: "CLEAN",
    headRollupState: "SUCCESS",
  },
} satisfies CiClean;
const readyPr = {
  kind: "ready-pr",
  context,
  proof: {
    mergeability: "clear",
    threads: [],
    ci: cleanCi,
    gate: {
      state: "OPEN",
      reviewDecision: "APPROVED",
      draft: "not-draft",
    },
  },
} satisfies ReadyPr;
const ready = {
  schemaVersion: 1,
  sequence: 1,
  observedAt: "2026-07-26T00:00:00.000Z",
  mode: "single",
  kind: "READY",
  terminal: true,
  exitCode: 0,
  scope: { kind: "single", pr: readyPr },
} satisfies ReadyVerdict;

void ready;

type AssertNotAssignable<Result extends false> = Result;

const refused = {
  kind: "allowed",
  basis: "merge-state",
  mergeStateStatus: "BLOCKED",
  headRollupState: "FAILURE",
} as const;

type RefusalIsNotAllowed = AssertNotAssignable<
  typeof refused extends GitHubMergeAllowed ? true : false
>;

const refusedCi = { ...cleanCi, github: refused };
type RefusalIsNotClean = AssertNotAssignable<typeof refusedCi extends CiClean ? true : false>;

const readyWithBlockerExit = { ...ready, exitCode: 4 } as const;
type ReadyCannotCarryBlockerExit = AssertNotAssignable<
  typeof readyWithBlockerExit extends ReadyVerdict ? true : false
>;

const unprovenPr = { kind: "ready-pr", context } as const;

type ReadyNeedsProof = AssertNotAssignable<typeof unprovenPr extends ReadyPr ? true : false>;

const undeterminedCi = {
  ...cleanCi,
  github: {
    kind: "undetermined",
    mergeStateStatus: "UNKNOWN",
    headRollupState: "SUCCESS",
  },
} satisfies CiClean;

const undeterminedReady = { ...readyPr, proof: { ...readyPr.proof, ci: undeterminedCi } };
type ReadyNeedsSettledAllowance = AssertNotAssignable<
  typeof undeterminedReady extends ReadyPr ? true : false
>;

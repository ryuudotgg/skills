import type { Declaration } from "../reviewers/declaration.ts";

export type Author = { login: string } | null;
export type Connection<Node> = { nodes: Node[] };
export type Comment = {
  author: Author;
  body: string | null;
  createdAt: string;
  updatedAt?: string | null;
};
export type Review = {
  author: Author;
  state?: string;
  body: string | null;
  submittedAt: string | null;
  commit: { oid: string } | null;
};
export type CheckRun = {
  __typename: "CheckRun";
  name: string;
  status: string;
  conclusion?: string | null;
  title?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  checkSuite?: { createdAt: string } | null;
};
export type StatusContext = {
  __typename: "StatusContext";
  context: string;
  state: string;
  createdAt: string;
  description?: string | null;
};
export type Commit = {
  oid: string;
  committedDate: string;
  checkSuites: Connection<{ createdAt: string }>;
  statusCheckRollup: {
    contexts: Connection<CheckRun | StatusContext> & {
      pageInfo?: { hasNextPage: boolean; endCursor?: string | null };
    };
  } | null;
};
export type PullRequest = {
  body: string;
  createdAt: string;
  timelineItems: Connection<{ createdAt: string }>;
  userContentEdits: Connection<{ editedAt: string; editor: Author }>;
  comments: Connection<Comment> & {
    pageInfo?: { hasPreviousPage: boolean; startCursor: string | null };
  };
  reviews: Connection<Review>;
  reviewThreads: Connection<{
    isResolved?: boolean;
    comments: Connection<{ author: Author; body?: string | null }>;
    latest?: Connection<{ author: Author }>;
  }>;
  commits: Connection<{ commit: Commit }> & { totalCount?: number };
};
export type Snapshot = {
  pr: PullRequest;
  comments: Comment[];
  headChecks: Record<string, CheckRun[]>;
};
export type Presence = {
  check: "pending" | "completed" | "missing";
  seen: boolean;
  event: "open" | "ready" | "push" | "trigger";
  elapsed: number;
  age: number | null;
  gate: "pending" | "appear" | "absent" | "timeout" | "no-review" | "decide";
};
export type Fixes = { commits: number; lines: number; added: number; moved: boolean };
export type Verdict =
  | "absent"
  | "wait"
  | "triage"
  | "done"
  | "rereview"
  | `${"absent" | "wait" | "triage" | "done" | "rereview" | "handback" | "unavailable"} ${string}`;
export type ReviewerInput = {
  phase: "gate" | "decide";
  outcome: "fixed" | "dismissed" | null;
  critical: boolean;
  snapshot: Snapshot;
  presence: Presence;
  declaration: Declaration;
  settings: Record<string, string>;
  limits: { window: number; cap: number };
  now: string;
};
export type Reviewer<Facts extends { fixesFrom: string | null }> = {
  headChecks?: readonly string[];
  facts(input: ReviewerInput): Facts;
  decide(facts: Facts, fixes: Fixes | null, input: ReviewerInput): Verdict;
};
export type ReadResult = { code: number; stdout: string; stderr: string };
export type ReadRunner = (args: readonly string[], deadline: number) => Promise<ReadResult>;
export type Dependencies = {
  root: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  gh: ReadRunner;
  git: ReadRunner;
  clock: () => number;
  sleep: (seconds: number) => Promise<void>;
  stderr?: (text: string) => void;
};
export type CommandOutput = { code: number; stdout: string; stderr: string };

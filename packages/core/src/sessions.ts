import type { Host } from "./events.ts";

export const SESSION_EVENT = "session";

export const SESSION_STATS_EVENT = "session-stats";

export const POLICY_EVENT = "policy";

export const TRANSCRIPT_EVENT = "transcript";

export const SESSION_POLICIES = ["off", "stats", "redacted", "full"] as const;

export type SessionPolicy = (typeof SESSION_POLICIES)[number];

export type PolicyRecord = { policy: SessionPolicy };

export const DEFAULT_POLICY: SessionPolicy = "redacted";

export function isSessionPolicy(value: unknown): value is SessionPolicy {
  return (SESSION_POLICIES as readonly unknown[]).includes(value);
}

export function strictestPolicy(policies: Iterable<SessionPolicy>): SessionPolicy | undefined {
  let strictest: SessionPolicy | undefined;
  for (const policy of policies)
    if (!strictest || SESSION_POLICIES.indexOf(policy) < SESSION_POLICIES.indexOf(strictest))
      strictest = policy;

  return strictest;
}

export function policyAllows(policy: SessionPolicy, needed: SessionPolicy): boolean {
  return SESSION_POLICIES.indexOf(policy) >= SESSION_POLICIES.indexOf(needed);
}

export type TranscriptRecord = {
  host: Host;
  session: string;
  series: number;
  chunk: number;
  first: number;
  last: number;
  sha256: string;
  blob: string;
  bytes: number;
  policy: SessionPolicy;
  rules: string;
  digest: string;
  digestBlob: string;
  cwd?: string;
  root?: string;
  home?: string;
};

export type SessionRecord = {
  host: Host;
  session: string;
  branch: string;
  plans: string[];
  source: string;
  started: string;
};

export const USAGE_FIELDS = {
  claude: ["in", "out", "cacheRead", "cacheWrite"],
  codex: ["in", "out", "cached", "reasoning", "total"],
  opencode: ["in", "out"],
} as const satisfies Record<Host, readonly string[]>;

export type UsageField = (typeof USAGE_FIELDS)[Host][number];

export type Usage = { effort: string } & Partial<Record<UsageField, number>>;

export type SessionStats = {
  host: Host;
  session: string;
  models: Record<string, Usage>;
  tools: Record<string, number>;
  records: number;
  start: string | null;
  end: string | null;
  subagents: number;
};

export const UNKNOWN_EFFORT = "-";
export function mergedEffort(left: string, right: string): string {
  if (left === UNKNOWN_EFFORT) return right;
  if (right === UNKNOWN_EFFORT || left === right) return left;
  return "mixed";
}

export function sessionTokens(stats: Pick<SessionStats, "models">): number {
  return Object.values(stats.models).reduce(
    (sum, usage) => sum + (usage.in ?? 0) + (usage.out ?? 0),
    0,
  );
}

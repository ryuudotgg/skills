import type { Host } from "./events.ts";

export const SESSION_EVENT = "session";

export const SESSION_STATS_EVENT = "session-stats";

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

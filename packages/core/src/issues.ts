import type { PlanEvent } from "./events.ts";

export const ISSUE_FILED = "issue";
export const ISSUE_CLOSED = "issue-closed";

export type IssueFiled = { n: number; title: string; body: string | null; from: string | null };

export type IssueClosed = { reason: string; resolvedBy: string[] };

export type IssueState = { kind: "open" } | { kind: "closed"; reason: string; at: string };

export type Issue = IssueFiled & { project: string; filed: string; state: IssueState };

export function issueRef(issue: { project: string; n: number }): string {
  return `${issue.project}#${issue.n}`;
}

export function issuePlan(n: number): string {
  return `#${n}`;
}

function fields(payload: unknown): Record<string, unknown> | undefined {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : undefined;
}

function nullableText(value: unknown): string | null | undefined {
  return value === null || typeof value === "string" ? value : undefined;
}

export function filedFrom(payload: unknown): IssueFiled | undefined {
  const { n, title, body, from } = fields(payload) ?? {};
  if (!Number.isSafeInteger(n) || (n as number) < 1 || typeof title !== "string") return undefined;

  const text = nullableText(body);
  const ref = nullableText(from);
  if (text === undefined || ref === undefined) return undefined;

  return { n: n as number, title, body: text, from: ref };
}

export function closedFrom(payload: unknown): IssueClosed | undefined {
  const { reason, resolvedBy } = fields(payload) ?? {};
  if (typeof reason !== "string" || !Array.isArray(resolvedBy)) return undefined;
  if (!resolvedBy.every((ref) => typeof ref === "string")) return undefined;

  return { reason, resolvedBy };
}

function compareIssues(left: Issue, right: Issue): number {
  if (left.project !== right.project) return left.project < right.project ? -1 : 1;
  return left.n - right.n;
}

export function foldIssues(events: Iterable<PlanEvent>): Issue[] {
  const issues = new Map<string, Issue>();
  for (const event of events) {
    if (event.kind !== "stored") continue;

    if (event.type === ISSUE_FILED) {
      const filed = filedFrom(event.payload);
      const key = `${event.project}${event.plan}`;
      if (!filed || event.plan !== issuePlan(filed.n) || issues.has(key)) continue;

      issues.set(key, {
        ...filed,
        project: event.project,
        filed: event.ts,
        state: { kind: "open" },
      });

      continue;
    }

    if (event.type !== ISSUE_CLOSED) continue;

    const key = `${event.project}${event.plan}`;
    const issue = issues.get(key);
    const closed = closedFrom(event.payload);
    if (!issue || !closed || issue.state.kind === "closed") continue;

    issues.set(key, { ...issue, state: { kind: "closed", reason: closed.reason, at: event.ts } });
  }

  return [...issues.values()].sort(compareIssues);
}

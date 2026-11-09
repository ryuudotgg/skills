import type { PlanEvent } from "./events.ts";

export const ISSUE_FILED = "issue";
export const ISSUE_CLOSED = "issue-closed";
export const ISSUE_LINK = "issue-link";

export type LinkKind = "blocks" | "resolves";

export type IssueLinked = { ref: string; kind: LinkKind | "unlinked" };

export type IssueLink = { ref: string; kind: LinkKind };

export type IssueFiled = { n: number; title: string; body: string | null; from: string | null };

export type IssueClosed = { reason: string; resolvedBy: string[] };

export type IssueState = { kind: "open" } | { kind: "closed"; reason: string; at: string };

export type Issue = IssueFiled & {
  project: string;
  filed: string;
  state: IssueState;
  links: IssueLink[];
};

export function issueRef(issue: { project: string; n: number }): string {
  return `${issue.project}#${issue.n}`;
}

export function issuesByRef(issues: Iterable<Issue>): Map<string, Issue> {
  return new Map([...issues].map((issue) => [issueRef(issue), issue]));
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

const LINK_KINDS: readonly string[] = ["blocks", "resolves", "unlinked"];
export function linkedFrom(payload: unknown): IssueLinked | undefined {
  const { ref, kind } = fields(payload) ?? {};
  if (typeof ref !== "string" || typeof kind !== "string" || !LINK_KINDS.includes(kind))
    return undefined;

  return { ref, kind: kind as IssueLinked["kind"] };
}

export function resolvers(issue: Issue): string[] {
  return issue.links.flatMap((link) => (link.kind === "resolves" ? [link.ref] : []));
}

function relink(links: readonly IssueLink[], linked: IssueLinked): IssueLink[] {
  if (linked.kind === "unlinked")
    return links.filter((link) => link.kind !== "resolves" || link.ref !== linked.ref);

  const { ref, kind } = linked;
  return links.some((link) => link.ref === ref && link.kind === kind)
    ? [...links]
    : [...links, { ref, kind }];
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
        links: [],
      });

      continue;
    }

    const key = `${event.project}${event.plan}`;
    const issue = issues.get(key);
    if (event.type === ISSUE_LINK) {
      const linked = linkedFrom(event.payload);
      if (issue && linked) issues.set(key, { ...issue, links: relink(issue.links, linked) });
      continue;
    }

    if (event.type !== ISSUE_CLOSED) continue;

    const closed = closedFrom(event.payload);
    if (!issue || !closed || issue.state.kind === "closed") continue;

    issues.set(key, { ...issue, state: { kind: "closed", reason: closed.reason, at: event.ts } });
  }

  return [...issues.values()].sort(compareIssues);
}

export function inboxLines(issues: Iterable<Issue>): string[] {
  const open = [...issues].filter((issue) => issue.state.kind === "open");
  if (open.length === 0) return [];

  return [
    `INBOX ${open.length}`,
    ...open.map((issue) => `${issueRef(issue)} ${issue.title} from ${issue.from ?? "-"}`),
  ];
}

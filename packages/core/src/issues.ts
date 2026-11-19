import type { PlanEvent } from "./events.ts";
import { fields } from "./payload.ts";

export const ISSUE_FILED = "issue";
export const ISSUE_CLOSED = "issue-closed";
export const ISSUE_LINK = "issue-link";

export type LinkKind = "blocks" | "resolves";

export type IssueLinked = { ref: string; kind: LinkKind | "unlinked"; filing?: string };

export type IssueLink = { ref: string; kind: LinkKind };

export type IssueFiled = { n: number; title: string; body: string | null; from: string | null };

export type IssueClosed = { reason: string; resolvedBy: string[]; filing?: string };

export type IssueState = { kind: "open" } | { kind: "closed"; reason: string; at: string };

export type Filing = IssueFiled & {
  id: string;
  filed: string;
  state: IssueState;
  links: IssueLink[];
};

export type Forward = { ref: string; to: string };

export type Issue = Filing & { project: string; rivals: Filing[]; forwards: Forward[] };

export function issueRef(issue: { project: string; n: number }): string {
  return `${issue.project}#${issue.n}`;
}

export function issuesByRef(issues: Iterable<Issue>): Map<string, Issue> {
  return new Map([...issues].map((issue) => [issueRef(issue), issue]));
}

export function issuePlan(n: number): string {
  return `#${n}`;
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

export function renumberedFrom(payload: unknown): string | undefined {
  const { moved } = fields(payload) ?? {};
  return typeof moved === "string" ? moved : undefined;
}

function filingOf(filing: unknown): { filing?: string } | undefined {
  if (filing === undefined) return {};
  return typeof filing === "string" ? { filing } : undefined;
}

const LINK_KINDS: readonly string[] = ["blocks", "resolves", "unlinked"];
export function linkedFrom(payload: unknown): IssueLinked | undefined {
  const { ref, kind, filing } = fields(payload) ?? {};
  if (typeof ref !== "string" || typeof kind !== "string" || !LINK_KINDS.includes(kind))
    return undefined;

  const reference = filingOf(filing);
  return reference && { ref, kind: kind as IssueLinked["kind"], ...reference };
}

export function resolvers(filing: Filing): string[] {
  return filing.links.flatMap((link) => (link.kind === "resolves" ? [link.ref] : []));
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
  const { reason, resolvedBy, filing } = fields(payload) ?? {};
  if (typeof reason !== "string" || !Array.isArray(resolvedBy)) return undefined;
  if (!resolvedBy.every((ref) => typeof ref === "string")) return undefined;

  const reference = filingOf(filing);
  return reference && { reason, resolvedBy, ...reference };
}

function compareIssues(left: Issue, right: Issue): number {
  if (left.project !== right.project) return left.project < right.project ? -1 : 1;
  return left.n - right.n;
}

function withFiling(issue: Issue, id: string, change: (filing: Filing) => Filing): Issue {
  if (issue.id === id) return { ...issue, ...change(issue) };
  return {
    ...issue,
    rivals: issue.rivals.map((rival) => (rival.id === id ? change(rival) : rival)),
  };
}

export function foldIssues(events: Iterable<PlanEvent>): Issue[] {
  const issues = new Map<string, Issue>();
  const placed = new Map<string, { key: string; project: string; filed: string }>();
  const movedTo = new Map<string, string>();
  const forwarded: { key: string; ref: string; reference: string }[] = [];

  const path = (reference: string) => {
    const ids = [reference];
    for (let next = movedTo.get(reference); next !== undefined; next = movedTo.get(next))
      ids.push(next);

    return ids;
  };

  const latest = (reference: string) => path(reference).at(-1) ?? reference;

  const holding = (project: string, key: string, reference: string | undefined) => {
    if (reference === undefined) {
      const holder = issues.get(key);
      return holder && { key, id: holder.id };
    }

    const id = latest(reference);
    const place = placed.get(id);
    return place?.project === project ? { key: place.key, id } : undefined;
  };

  for (const event of events) {
    if (event.kind !== "stored") continue;

    const key = `${event.project}${event.plan}`;
    if (event.type === ISSUE_FILED) {
      const filed = filedFrom(event.payload);
      const from = renumberedFrom(event.payload);
      if (!filed || event.plan !== issuePlan(filed.n)) continue;

      const found = from === undefined ? undefined : placed.get(from);
      const original = found?.project === event.project ? found : undefined;
      const left = original && issues.get(original.key);
      const taken = left?.rivals.find((rival) => rival.id === from);
      if (left && taken) {
        issues.set(original.key, {
          ...left,
          rivals: left.rivals.filter((rival) => rival !== taken),
        });

        movedTo.set(taken.id, event.id);
      }

      const filing: Filing = {
        ...filed,
        id: event.id,
        filed: original?.filed ?? event.ts,
        state: taken?.state ?? { kind: "open" },
        links: taken?.links ?? [],
      };

      const held = issues.get(key);

      placed.set(event.id, { key, project: event.project, filed: filing.filed });
      issues.set(
        key,
        held
          ? { ...held, rivals: [...held.rivals, filing] }
          : { ...filing, project: event.project, rivals: [], forwards: [] },
      );

      continue;
    }

    if (event.type === ISSUE_LINK) {
      const linked = linkedFrom(event.payload);
      const target = linked && holding(event.project, key, linked.filing);
      const issue = target && issues.get(target.key);

      if (linked?.kind === "blocks" && linked.filing !== undefined && target)
        forwarded.push({ key, ref: linked.ref, reference: linked.filing });

      if (linked && target && issue)
        issues.set(
          target.key,
          withFiling(issue, target.id, (filing) => ({
            ...filing,
            links: relink(filing.links, linked),
          })),
        );

      continue;
    }

    if (event.type !== ISSUE_CLOSED) continue;

    const closed = closedFrom(event.payload);
    const target = closed && holding(event.project, key, closed.filing);
    const issue = target && issues.get(target.key);
    if (!closed || !target || !issue) continue;

    const state: IssueState = { kind: "closed", reason: closed.reason, at: event.ts };
    issues.set(
      target.key,
      withFiling(issue, target.id, (filing) =>
        filing.state.kind === "closed" ? filing : { ...filing, state },
      ),
    );
  }

  for (const { key, ref, reference } of forwarded) {
    const keys = path(reference).flatMap((id) => placed.get(id)?.key ?? []);
    const to = keys.at(-1);
    for (const from of new Set([key, ...keys])) {
      const issue = issues.get(from);
      if (!issue || to === undefined || from === to) continue;
      if (issue.forwards.some((one) => one.ref === ref && one.to === to)) continue;

      issues.set(from, { ...issue, forwards: [...issue.forwards, { ref, to }] });
    }
  }

  return [...issues.values()].sort(compareIssues);
}

export function inConflict(issue: Issue): boolean {
  return issue.rivals.length > 0;
}

export function conflictRefusal(ref: string): string {
  return `${ref} is filed more than once, run skills issues renumber ${ref} first`;
}

export function inInbox(issue: Issue): boolean {
  return issue.state.kind === "open" || inConflict(issue);
}

export function conflictLine(issue: Issue): string | undefined {
  if (!inConflict(issue)) return undefined;

  const ref = issueRef(issue);
  const titles = [issue, ...issue.rivals].map((filing) => filing.title).join(" | ");
  return `${ref} conflict: ${titles}, run skills issues renumber ${ref}`;
}

export function inboxLines(issues: Iterable<Issue>): string[] {
  const shown = [...issues].filter(inInbox);
  if (shown.length === 0) return [];

  return [
    `INBOX ${shown.length}`,
    ...shown.map(
      (issue) =>
        conflictLine(issue) ?? `${issueRef(issue)} ${issue.title} from ${issue.from ?? "-"}`,
    ),
  ];
}

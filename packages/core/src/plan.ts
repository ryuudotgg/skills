import type {
  CheckVerdict,
  PlanEvent,
  PrRecord,
  PrState,
  ReviewerOutcome,
  RoundRecord,
  RowType,
} from "./events.ts";
import { COLUMNS, type IndexRow } from "./rows.ts";
import {
  SESSION_EVENT,
  SESSION_STATS_EVENT,
  TRANSCRIPT_EVENT,
  type SessionRecord,
  type SessionStats,
} from "./sessions.ts";

export type TimelineFact =
  | { kind: "row"; type: Exclude<RowType, "row"> }
  | { kind: "status"; from: string | undefined; to: string; changed: string[] }
  | { kind: "trail"; verb: string; detail: string }
  | { kind: "thread"; thread: string }
  | { kind: "session"; session: string }
  | { kind: "pr"; pr: number; state: PrState; verdict: CheckVerdict | null; head: string }
  | { kind: "round"; pr: number; outcomes: [string, ReviewerOutcome][]; verdict: string }
  | { kind: "revision"; sha256: string; size: number }
  | { kind: "other"; type: string };

export type TimelineEntry = { ts: string; machine: string; fact: TimelineFact };

export type RevisionEntry = {
  captured: string;
  sha256: string;
  machine: string;
  size: number;
  path: string;
};

export type SessionEntry = {
  session: string;
  host: string;
  branch: string;
  machine: string;
  models: string[];
  in: number;
  out: number;
  tools: number;
};

export type PlanPage = {
  row: IndexRow | undefined;
  timeline: TimelineEntry[];
  revisions: RevisionEntry[];
  sessions: SessionEntry[];
  blocks: [rule: string, count: number][];
};

const IN_SESSION_ROW = new Set([SESSION_STATS_EVENT, TRANSCRIPT_EVENT]);

const HOOK_BLOCK = "hook-block";

const HOSTS: readonly unknown[] = ["claude", "codex", "opencode"];

function fields(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

const PR_STATES: readonly unknown[] = ["open", "merged", "closed"];

const CHECK_VERDICTS: readonly unknown[] = ["green", "red", "pending", null];

const OUTCOMES: readonly unknown[] = ["fixed", "dismissed"];

export function prFrom(payload: unknown): PrRecord | undefined {
  const record = fields(payload);
  if (!record || !isCount(record.pr) || typeof record.branch !== "string") return undefined;
  if (!PR_STATES.includes(record.state) || !CHECK_VERDICTS.includes(record.verdict))
    return undefined;

  if (typeof record.head !== "string" || !Array.isArray(record.failing)) return undefined;
  if (!record.failing.every(isText)) return undefined;

  return {
    pr: record.pr,
    branch: record.branch,
    state: record.state as PrState,
    head: record.head,
    verdict: record.verdict as CheckVerdict | null,
    failing: record.failing,
  };
}

export function roundFrom(payload: unknown): RoundRecord | undefined {
  const record = fields(payload);
  const outcomes = fields(record?.outcomes);
  if (!record || !outcomes || !isCount(record.pr) || !isText(record.verdict)) return undefined;
  if (typeof record.branch !== "string" || typeof record.head !== "string") return undefined;
  if (!Object.values(outcomes).every((outcome) => OUTCOMES.includes(outcome))) return undefined;

  return {
    pr: record.pr,
    branch: record.branch,
    head: record.head,
    outcomes: outcomes as Record<string, ReviewerOutcome>,
    verdict: record.verdict,
  };
}

export function revisionFrom(payload: unknown): Omit<RevisionEntry, "machine"> | undefined {
  const record = fields(payload);
  if (!record || !isText(record.path) || !isText(record.captured)) return undefined;
  if (typeof record.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.sha256)) return undefined;
  if (!isCount(record.size)) return undefined;

  return { captured: record.captured, sha256: record.sha256, size: record.size, path: record.path };
}

export function sessionFrom(payload: unknown): SessionRecord | undefined {
  const record = fields(payload);
  if (!record || !isText(record.session) || !HOSTS.includes(record.host)) return undefined;
  if (typeof record.branch !== "string" || !Array.isArray(record.plans)) return undefined;
  if (!record.plans.every(isText)) return undefined;

  return record as SessionRecord;
}

type Spend = Pick<SessionEntry, "models" | "in" | "out" | "tools">;

export function spendFrom(payload: unknown): (Spend & { key: string }) | undefined {
  const record = fields(payload);
  const models = fields(record?.models);
  const tools = fields(record?.tools);
  if (!record || !models || !tools || !isText(record.session)) return undefined;
  if (!HOSTS.includes(record.host)) return undefined;

  const usages = Object.values(models).map(fields);
  if (!usages.every((usage) => usage !== undefined)) return undefined;
  if (!Object.values(tools).every(isCount)) return undefined;

  const sum = (name: "in" | "out") =>
    usages.reduce((total, usage) => total + (isCount(usage[name]) ? usage[name] : 0), 0);

  return {
    key: sessionKey(record as SessionStats),
    models: Object.keys(models as SessionStats["models"]),
    in: sum("in"),
    out: sum("out"),
    tools: Object.values(tools as Record<string, number>).reduce((total, n) => total + n, 0),
  };
}

function sessionKey(record: Pick<SessionRecord, "host" | "session">): string {
  return `${record.host}\t${record.session}`;
}

function blockRules(payload: unknown): string[] {
  const rules = fields(payload)?.rules;
  return Array.isArray(rules) ? rules.filter(isText) : [];
}

function storedFact(event: PlanEvent & { kind: "stored" }): TimelineFact {
  const other: TimelineFact = { kind: "other", type: event.type };
  if (event.type === SESSION_EVENT) {
    const session = sessionFrom(event.payload);
    return session ? { kind: "session", session: session.session } : other;
  }

  if (event.type === "pr") {
    const pr = prFrom(event.payload);
    return pr
      ? { kind: "pr", pr: pr.pr, state: pr.state, verdict: pr.verdict, head: pr.head }
      : other;
  }

  if (event.type === "round") {
    const round = roundFrom(event.payload);
    const outcomes = round ? Object.entries(round.outcomes) : [];
    return round ? { kind: "round", pr: round.pr, outcomes, verdict: round.verdict } : other;
  }

  if (event.type === "revision") {
    const revision = revisionFrom(event.payload);
    return revision ? { kind: "revision", sha256: revision.sha256, size: revision.size } : other;
  }

  return other;
}

function changedColumns(from: IndexRow | undefined, to: IndexRow): string[] {
  return COLUMNS.filter((column) => column !== "updated" && from && from[column] !== to[column]);
}

function factOf(event: PlanEvent, row: IndexRow | undefined): TimelineFact {
  if (event.kind === "stored") return storedFact(event);
  if (event.kind === "trail")
    return event.type === "thread"
      ? { kind: "thread", thread: event.detail }
      : { kind: "trail", verb: event.type, detail: event.detail };

  if (event.type !== "row") return { kind: "row", type: event.type };

  const changed = changedColumns(row, event.row);
  return { kind: "status", from: row?.status, to: event.row.status, changed };
}

type Seen = { record: SessionRecord; machine: string };

function sessionEntry({ record, machine }: Seen, spend: Spend | undefined): SessionEntry {
  const { session, host, branch } = record;
  const { models = [], in: tokensIn = 0, out = 0, tools = 0 } = spend ?? {};
  return { session, host, branch, machine, models, in: tokensIn, out, tools };
}

function payloadOf(event: PlanEvent, type: string): unknown {
  return event.kind === "stored" && event.type === type ? event.payload : undefined;
}

function touches(event: PlanEvent, project: string, id: string): boolean {
  if (event.project !== project) return false;
  if (event.plan === id) return true;
  return !!sessionFrom(payloadOf(event, SESSION_EVENT))?.plans.includes(id);
}

export function planPage(events: Iterable<PlanEvent>, project: string, id: string): PlanPage {
  const page: PlanPage = { row: undefined, timeline: [], revisions: [], sessions: [], blocks: [] };
  const spends = new Map<string, Spend>();
  const latest = new Map<string, Seen>();
  const members = new Set<string>();
  const blocks = new Map<string, number>();
  for (const event of events) {
    const spend = spendFrom(payloadOf(event, SESSION_STATS_EVENT));
    if (spend) spends.set(spend.key, spend);

    const session = sessionFrom(payloadOf(event, SESSION_EVENT));
    if (session) latest.set(sessionKey(session), { record: session, machine: event.machine });
    if (!touches(event, project, id)) continue;
    if (session) members.add(sessionKey(session));
    if (event.plan !== id || IN_SESSION_ROW.has(event.type)) continue;

    if (event.type === HOOK_BLOCK) {
      for (const rule of blockRules(payloadOf(event, HOOK_BLOCK)))
        blocks.set(rule, (blocks.get(rule) ?? 0) + 1);

      continue;
    }

    const revision = revisionFrom(payloadOf(event, "revision"));
    if (revision) page.revisions.push({ ...revision, machine: event.machine });

    page.timeline.push({ ts: event.ts, machine: event.machine, fact: factOf(event, page.row) });
    if (event.kind === "row") page.row = event.row;
  }

  page.sessions = [...members].map((key) => sessionEntry(latest.get(key)!, spends.get(key)));
  page.blocks = [...blocks].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return page;
}

import { secondStamp, type Stamp } from "./clock.ts";
import {
  ISSUE_CLOSED,
  ISSUE_FILED,
  ISSUE_LINK,
  type IssueClosed,
  type IssueFiled,
  type IssueLinked,
} from "./issues.ts";
import {
  LEASE,
  LEASE_CONFLICT,
  LEASE_RELEASED,
  type LeaseConflict,
  type LeaseHeld,
  type LeaseReleased,
} from "./leases.ts";
import { MACHINE_EVENT, type Facts } from "./machine.ts";
import { MOVED, type Moved } from "./move.ts";
import { HEARTBEAT, type Heartbeat } from "./pulse.ts";
import {
  POLICY_EVENT,
  SESSION_EVENT,
  SESSION_STATS_EVENT,
  TRANSCRIPT_EVENT,
  type PolicyRecord,
  type SessionRecord,
  type SessionStats,
  type TranscriptRecord,
} from "./sessions.ts";
import { flatRow, rowKey, type IndexRow } from "./rows.ts";
import { AD_HOC_ID, type TrailEntry } from "./trail.ts";

export const TRAIL_EVENTS = [
  "start",
  "review",
  "handback",
  "done",
  "thread",
  "wave",
  "nudge",
  "conflict-sent",
] as const;

export const AD_HOC_EVENTS = ["start", "handback", "nudge"] as const;

export const ROW_EVENTS = ["added", "row", "imported"] as const;

export const STORE_EVENTS = [
  "hook-block",
  "round",
  "pr",
  "eval",
  "digest",
  MACHINE_EVENT,
  ISSUE_FILED,
  ISSUE_CLOSED,
  ISSUE_LINK,
  SESSION_EVENT,
  SESSION_STATS_EVENT,
  POLICY_EVENT,
  TRANSCRIPT_EVENT,
  "revision",
  "copy-conflict",
  LEASE,
  LEASE_RELEASED,
  LEASE_CONFLICT,
  HEARTBEAT,
  "blob-deleted",
  MOVED,
] as const;

export type StoreType = (typeof STORE_EVENTS)[number];

export type Host = "claude" | "codex" | "opencode";

export type HookBlock = { rules: string[]; host: Host };

export type ReviewerOutcome = "fixed" | "dismissed";

export type RoundRecord = {
  pr: number;
  branch: string;
  head: string;
  outcomes: Record<string, ReviewerOutcome>;
  verdict: string;
};

export type PrState = "open" | "merged" | "closed";

export type CheckVerdict = "green" | "red" | "pending";

export type PrRecord = {
  pr: number;
  branch: string;
  state: PrState;
  head: string;
  verdict: CheckVerdict | null;
  failing: string[];
};

export type EvalRecord = {
  case: string;
  models: string[];
  roster: string;
  exit: number;
  verdict: "pass" | "fail" | null;
  grade: string | null;
  duration: number;
};

export type DigestRecord = { week: string; markdown: string };

export type RevisionRecord = {
  path: string;
  sha256: string;
  captured: string;
  size: number;
  blob: string;
  base?: string;
};

export const CHUNK_SIZE = 1024 * 1024;

export const MAX_FILE_SIZE = 128 * CHUNK_SIZE;

export const BLOB_MAX = 16 * CHUNK_SIZE;

export type FileChunk = { sha256: string; blob: string };

export type FileRevisionRecord = {
  path: string;
  sha256: string;
  captured: string;
  size: number;
  executable: boolean;
  chunks: FileChunk[];
  base?: string;
  parent?: string;
};

export type BlobDeletedRecord = { blob: string };

export type CopyConflictRecord = {
  path: string;
  sha256: string;
  event: string;
  local: string;
};

export type StorePayloads = {
  "hook-block": HookBlock;
  round: RoundRecord;
  pr: PrRecord;
  eval: EvalRecord;
  digest: DigestRecord;
  machine: Facts;
  issue: IssueFiled;
  "issue-closed": IssueClosed;
  "issue-link": IssueLinked;
  session: SessionRecord;
  "session-stats": SessionStats;
  policy: PolicyRecord;
  transcript: TranscriptRecord;
  revision: RevisionRecord | FileRevisionRecord;
  "copy-conflict": CopyConflictRecord;
  lease: LeaseHeld;
  "lease-released": LeaseReleased;
  "lease-conflict": LeaseConflict;
  heartbeat: Heartbeat;
  "blob-deleted": BlobDeletedRecord;
  moved: Moved;
};

export type StoreDraft = {
  [T in StoreType]: {
    kind: "stored";
    type: T;
    at: number;
    project: string;
    plan: string;
    payload: StorePayloads[T];
  };
}[StoreType];

export type RowType = (typeof ROW_EVENTS)[number];

type Placed = Stamp & { ts: string; project: string; plan: string };

export type RowEvent = Placed & { kind: "row"; type: RowType; row: IndexRow };

export type TrailEvent = Placed & {
  kind: "trail";
  type: string;
  legacy: boolean;
  detail: string;
  line: string;
};

export type StoredEvent = Placed & { kind: "stored"; type: string; payload: unknown };

export type PlanEvent = RowEvent | TrailEvent | StoredEvent;

export type EventRecord = Placed & { type: string; legacy: boolean; payload: unknown };

export type EventDraft =
  | { kind: "row"; type: RowType; at: number; project: string; row: IndexRow }
  | { kind: "trail"; at: number; entry: TrailEntry }
  | StoreDraft;

export function trailVerbs(plan: string): readonly string[] {
  return plan === AD_HOC_ID ? AD_HOC_EVENTS : TRAIL_EVENTS;
}

export function isTrailVerb(type: string, plan: string): boolean {
  return trailVerbs(plan).includes(type);
}

function isRowType(type: string): type is RowType {
  return (ROW_EVENTS as readonly string[]).includes(type);
}

export function recordOf(draft: EventDraft): Omit<EventRecord, keyof Stamp> {
  if (draft.kind === "row")
    return {
      ts: secondStamp(draft.at),
      project: draft.project,
      plan: draft.row.id,
      type: draft.type,
      legacy: false,
      payload: { row: draft.row },
    };

  if (draft.kind === "stored")
    return {
      ts: secondStamp(draft.at),
      project: draft.project,
      plan: draft.plan,
      type: draft.type,
      legacy: false,
      payload: draft.payload,
    };

  const { entry } = draft;
  return {
    ts: entry.ts,
    project: entry.project,
    plan: entry.id,
    type: entry.event,
    legacy: !isTrailVerb(entry.event, entry.id),
    payload: { detail: entry.detail, line: entry.line },
  };
}

function field(payload: unknown, name: string): unknown {
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)[name]
    : undefined;
}

function isTrailPayload(payload: unknown): boolean {
  return typeof field(payload, "detail") === "string" && typeof field(payload, "line") === "string";
}

function kindOf(record: EventRecord): PlanEvent["kind"] {
  if (record.legacy) return "trail";
  if (isRowType(record.type)) return "row";
  if ((STORE_EVENTS as readonly string[]).includes(record.type)) return "stored";
  if (isTrailVerb(record.type, record.plan)) return "trail";

  return isTrailPayload(record.payload) ? "trail" : "stored";
}

function malformed(record: EventRecord, expected: string): Error {
  return new Error(
    `event ${record.type} for ${record.project} ${record.plan} at ${record.ts} has no ${expected}`,
  );
}

export function eventFrom(record: EventRecord): PlanEvent {
  const { payload, legacy, ...placed } = record;
  const kind = kindOf(record);
  if (kind === "stored") return { ...placed, kind, payload };

  if (kind === "row") {
    const row = field(payload, "row");
    if (typeof row !== "object" || row === null) throw malformed(record, "row");
    return { ...placed, kind, type: record.type as RowType, row: flatRow(row as IndexRow) };
  }

  if (!isTrailPayload(payload)) throw malformed(record, "detail and line");

  return {
    ...placed,
    kind,
    legacy,
    detail: field(payload, "detail") as string,
    line: field(payload, "line") as string,
  };
}

export function foldRows(events: Iterable<PlanEvent>): Map<string, Map<string, IndexRow>> {
  const projects = new Map<string, Map<string, IndexRow>>();
  for (const event of events) {
    if (event.kind !== "row") continue;

    const rows = projects.get(event.project) ?? new Map<string, IndexRow>();

    projects.set(event.project, rows);
    rows.set(rowKey(event.row), event.row);
  }

  return projects;
}

export function trailOf(events: Iterable<PlanEvent>): TrailEntry[] {
  const trail: TrailEntry[] = [];
  for (const event of events)
    if (event.kind === "trail")
      trail.push({
        ts: event.ts,
        project: event.project,
        id: event.plan,
        event: event.type,
        detail: event.detail,
        line: event.line,
      });

  return trail;
}

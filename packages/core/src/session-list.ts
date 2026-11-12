import type { PlanEvent, StoredEvent } from "./events.ts";
import { sessionFrom, spendFrom } from "./plan.ts";
import { sessionKeyOf, type Policies } from "./policy.ts";
import {
  SESSION_EVENT,
  SESSION_STATS_EVENT,
  TRANSCRIPT_EVENT,
  type SessionPolicy,
} from "./sessions.ts";
import { parseTime } from "./time.ts";
import { AD_HOC_ID } from "./trail.ts";

export type SessionSummary = {
  host: string;
  session: string;
  project: string;
  branch: string;
  plans: string[];
  machine: string;
  models: string[];
  in: number;
  out: number;
  tools: number;
  start: string;
  end: string | null;
  duration: number | null;
  policy: SessionPolicy;
  digest: string | null;
};

type Span = { start: string | null; end: string | null };

type Folded = Pick<SessionSummary, "host" | "session" | "project" | "branch" | "machine"> & {
  started: string;
  plans: string[];
};

const SHA256 = /^[0-9a-f]{64}$/;

function spanOf(payload: unknown): Span {
  const record = payload as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
  return { start: text(record.start), end: text(record.end) };
}

function earlier(left: string, right: string): string {
  return (parseTime(right) ?? Infinity) < (parseTime(left) ?? Infinity) ? right : left;
}

function digestOf(payload: unknown): string | undefined {
  const digest = (payload as Record<string, unknown>).digest;
  return typeof digest === "string" && SHA256.test(digest) ? digest : undefined;
}

function durationOf({ start, end }: Span): number | null {
  const from = start === null ? undefined : parseTime(start);
  const to = end === null ? undefined : parseTime(end);
  return from === undefined || to === undefined || to < from ? null : to - from;
}

function unrecorded(event: StoredEvent, key: string, span: Span): Folded {
  const [host = "", session = ""] = key.split("\t");
  const started = span.start ?? event.ts;
  return {
    host,
    session,
    project: event.project,
    branch: AD_HOC_ID,
    machine: event.machine,
    started,
    plans: [],
  };
}

export function sessionList(events: Iterable<PlanEvent>, policies: Policies): SessionSummary[] {
  const sessions = new Map<string, Folded>();
  const spends = new Map<string, NonNullable<ReturnType<typeof spendFrom>>>();
  const spans = new Map<string, Span>();
  const digests = new Map<string, string>();
  for (const event of events) {
    const key = event.kind === "stored" ? sessionKeyOf(event) : undefined;
    if (key === undefined || event.kind !== "stored") continue;

    if (event.type === SESSION_STATS_EVENT) {
      const spend = spendFrom(event.payload);
      if (!spend) continue;

      const span = spanOf(event.payload);
      spends.set(key, spend);
      spans.set(key, span);

      if (!sessions.has(key)) sessions.set(key, unrecorded(event, key, span));
      continue;
    }

    if (event.type === TRANSCRIPT_EVENT) {
      const digest = digestOf(event.payload);
      if (digest) digests.set(key, digest);
      else digests.delete(key);

      continue;
    }

    const record = event.type === SESSION_EVENT ? sessionFrom(event.payload) : undefined;
    if (!record) continue;

    const seen = sessions.get(key);
    const links = record.plans.map((id) => `${event.project}/${id}`);
    sessions.set(key, {
      host: record.host,
      session: record.session,
      project: event.project,
      branch: record.branch,
      machine: event.machine,
      started: seen ? earlier(seen.started, record.started) : record.started,
      plans: [...new Set([...(seen?.plans ?? []), ...links])],
    });
  }

  const listed = [...sessions].map(([key, folded]): SessionSummary => {
    const { started, ...kept } = folded;
    const spend = spends.get(key);
    const span = spans.get(key) ?? { start: null, end: null };
    return {
      ...kept,
      models: spend?.models ?? [],
      in: spend?.in ?? 0,
      out: spend?.out ?? 0,
      tools: spend?.tools ?? 0,
      start: span.start ?? started,
      end: span.end,
      duration: durationOf({ start: span.start ?? started, end: span.end }),
      policy: policies.get(key) ?? "off",
      digest: digests.get(key) ?? null,
    };
  });

  const at = (summary: SessionSummary) => parseTime(summary.start) ?? -Infinity;
  return listed.sort(
    (left, right) =>
      at(right) - at(left) ||
      (left.session < right.session ? -1 : left.session > right.session ? 1 : 0),
  );
}

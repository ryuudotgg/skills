import type { PlanEvent, RoundRecord } from "./events.ts";
import { roundFrom, sessionFrom, spendFrom } from "./plan.ts";
import {
  POLICY_EVENT,
  SESSION_EVENT,
  SESSION_STATS_EVENT,
  isSessionPolicy,
  type SessionPolicy,
  type SessionStats,
} from "./sessions.ts";
import { DAY_MS, isoWeek } from "./time.ts";
import { AD_HOC_ID } from "./trail.ts";

export const STATS_WINDOWS = [7, 30, 90] as const;

export type StatsWindow = (typeof STATS_WINDOWS)[number];

export type StatsFilter = { days: StatsWindow; project: string | undefined };

export const PHASES = ["queue", "build", "review"] as const;

export type Phase = (typeof PHASES)[number];

export const EFFORTS = ["XS", "S", "M", "L"] as const;

export type Effort = (typeof EFFORTS)[number];

export type Tally = { name: string; value: number };

export type EffortMark = { project: string; id: string; effort: Effort; elapsed: number };

export type WeekCount = { week: string; launched: number; closed: number };

export type ReviewerCount = { reviewer: string; fixed: number; dismissed: number };

export type PhaseMedian = { median: number | undefined; count: number };

export type ClosedPlan = { project: string; id: string; status: string };

export type Stats = {
  projects: string[];
  closed: ClosedPlan[];
  phases: Record<Phase, PhaseMedian>;
  efforts: EffortMark[];
  unsized: number;
  models: Tally[];
  plans: Tally[];
  weeks: WeekCount[];
  blocks: Tally[];
  reviewers: ReviewerCount[];
};

type Track = {
  project: string;
  id: string;
  effort: string;
  status: string;
  added?: number;
  started?: number;
  open?: number;
  build?: number;
  handedBack?: number;
  done?: number;
};

type Spend = {
  home: string | undefined;
  head: { project: string; plan: string } | undefined;
  projects: Set<string>;
  plans: Set<string>;
  before: Tally[];
  latest: { wall: number; models: Tally[] } | undefined;
};

const CLOSED: readonly string[] = ["DONE", "DROPPED"];

function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function byName(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function ranked(totals: ReadonlyMap<string, number>): Tally[] {
  return [...totals]
    .map(([name, value]) => ({ name, value }))
    .sort((left, right) => right.value - left.value || byName(left.name, right.name));
}

function add(totals: Map<string, number>, name: string, value: number): void {
  totals.set(name, (totals.get(name) ?? 0) + value);
}

export function median(values: readonly number[]): number | undefined {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return undefined;
  if (sorted.length % 2 === 1) return sorted[middle];

  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function tracked(tracks: Map<string, Track>, event: PlanEvent): Track {
  const key = `${event.project}\t${event.plan}`;
  const found = tracks.get(key);
  if (found) return found;

  const track: Track = { project: event.project, id: event.plan, effort: "", status: "" };
  tracks.set(key, track);
  return track;
}

export function timeOf(event: PlanEvent): number {
  const at = Date.parse(event.ts);
  return Number.isNaN(at) ? event.wall : at;
}

function step(track: Track, event: PlanEvent): void {
  const at = timeOf(event);
  if (event.kind === "row") {
    track.effort = event.row.effort;
    track.status = event.row.status;
    if (event.type === "added") track.added ??= at;

    return;
  }

  if (event.kind !== "trail") return;

  if (event.type === "start") {
    track.started ??= at;
    track.open ??= at;
  }

  if (event.type === "handback") {
    if (track.open !== undefined) track.build = (track.build ?? 0) + at - track.open;
    track.open = undefined;
    track.handedBack ??= at;
  }

  if (event.type === "done") track.done = at;
}

function phases(track: Track): Record<Phase, number | undefined> {
  const { added, started, handedBack, done } = track;
  const queue = added !== undefined && started !== undefined ? started - added : undefined;
  if (track.status === "DROPPED") return { queue, build: undefined, review: undefined };

  const review = handedBack !== undefined && done !== undefined ? done - handedBack : undefined;
  const build = track.open === undefined ? track.build : undefined;
  return { queue, build, review };
}

function modelTokens(stats: SessionStats): Tally[] {
  return Object.entries(stats.models).map(([name, usage]) => ({
    name,
    value: count(usage.in) + count(usage.out),
  }));
}

function spent(latest: readonly Tally[], before: readonly Tally[]): Tally[] {
  return latest
    .map(({ name, value }) => ({
      name,
      value: Math.max(0, value - (before.find((model) => model.name === name)?.value ?? 0)),
    }))
    .filter((model) => model.value > 0);
}

function isEffort(value: string): value is Effort {
  return (EFFORTS as readonly string[]).includes(value);
}

function weekSpan(since: number, now: number): string[] {
  const weeks = new Set<string>();
  for (let at = since; at < now; at += 7 * DAY_MS) weeks.add(isoWeek(at));

  weeks.add(isoWeek(now));
  return [...weeks];
}

function spendOf(sessions: Map<string, Spend>, key: string): Spend {
  const found = sessions.get(key);
  if (found) return found;

  const spend: Spend = {
    home: undefined,
    head: undefined,
    projects: new Set(),
    plans: new Set(),
    before: [],
    latest: undefined,
  };

  sessions.set(key, spend);
  return spend;
}

function decisionKey(event: PlanEvent, round: RoundRecord): string {
  const outcomes = Object.entries(round.outcomes).sort(([left], [right]) => byName(left, right));
  return JSON.stringify([event.machine, event.ts, round.pr, round.head, round.verdict, outcomes]);
}

function distinct(sets: ReadonlyMap<string, ReadonlySet<string>>, week: string): number {
  return sets.get(week)?.size ?? 0;
}

function tokenTallies(
  sessions: ReadonlyMap<string, Spend>,
  policies: ReadonlyMap<string, SessionPolicy>,
  since: number,
  shown: (project: string) => boolean,
): Pick<Stats, "models" | "plans"> {
  const models = new Map<string, number>();
  const plans = new Map<string, number>();
  for (const session of sessions.values()) {
    const { latest, head, home } = session;
    if (!latest || latest.wall < since) continue;
    if ([...session.projects].some((project) => policies.get(project) === "off")) continue;

    const window = spent(latest.models, session.before);
    const total = window.reduce((sum, model) => sum + model.value, 0);
    const project = home ?? head?.project ?? AD_HOC_ID;
    if (shown(project)) for (const model of window) add(models, model.name, model.value);

    const named =
      session.plans.size > 0 || !head || head.plan === AD_HOC_ID
        ? session.plans
        : [`${head.project}\t${head.plan}`];

    for (const link of named) {
      const [linked = "", id = ""] = link.split("\t");
      if (shown(linked) && total > 0) add(plans, `${linked} ${id}`, total);
    }
  }

  return { models: ranked(models), plans: ranked(plans) };
}

export function silencedProjects(events: Iterable<PlanEvent>): Set<string> {
  const policies = new Map<string, SessionPolicy>();
  for (const event of events) {
    if (event.kind !== "stored" || event.type !== POLICY_EVENT) continue;
    const policy = (event.payload as { policy?: unknown } | null)?.policy;
    if (isSessionPolicy(policy)) policies.set(event.project, policy);
  }

  return new Set(
    [...policies].filter(([, policy]) => policy === "off").map(([project]) => project),
  );
}

export function statsOf(events: Iterable<PlanEvent>, now: number, filter: StatsFilter): Stats {
  const since = now - filter.days * DAY_MS;
  const inWindow = (event: PlanEvent) => timeOf(event) >= since && timeOf(event) <= now;
  const kept = (event: PlanEvent) =>
    inWindow(event) && (filter.project === undefined || event.project === filter.project);

  const projects = new Set<string>();
  const tracks = new Map<string, Track>();

  const sessions = new Map<string, Spend>();
  const policies = new Map<string, SessionPolicy>();
  const decisions = new Set<string>();

  const launched = new Map<string, Set<string>>();
  const done = new Map<string, Set<string>>();
  const blocks = new Map<string, number>();
  const reviewers = new Map<string, ReviewerCount>();

  const all = [...events];
  const silenced = silencedProjects(all);
  for (const event of all) {
    const shown = !silenced.has(event.project);
    if (shown && event.project !== AD_HOC_ID) projects.add(event.project);
    if (shown && event.kind !== "stored" && event.plan !== AD_HOC_ID)
      step(tracked(tracks, event), event);

    const counted = shown && kept(event);
    if (event.kind === "trail" && counted && (event.type === "wave" || event.type === "done")) {
      const series = event.type === "wave" ? launched : done;
      const week = isoWeek(timeOf(event));
      const plans = series.get(week) ?? new Set<string>();

      series.set(week, plans);
      plans.add(`${event.project}\t${event.plan}`);
    }

    if (event.kind !== "stored") continue;

    const policy = (event.payload as { policy?: unknown } | null)?.policy;
    if (event.type === POLICY_EVENT && isSessionPolicy(policy)) policies.set(event.project, policy);

    const session = event.type === SESSION_EVENT ? sessionFrom(event.payload) : undefined;
    if (session) {
      const spend = spendOf(sessions, `${session.host}\t${session.session}`);

      spend.home = event.project;
      spend.projects.add(event.project);
      for (const id of session.plans) spend.plans.add(`${event.project}\t${id}`);
    }

    const stats = event.type === SESSION_STATS_EVENT ? spendFrom(event.payload) : undefined;
    if (stats && timeOf(event) <= now) {
      const spend = spendOf(sessions, stats.key);
      const models = modelTokens(event.payload as SessionStats);

      spend.head = { project: event.project, plan: event.plan };
      spend.projects.add(event.project);
      spend.latest = { wall: timeOf(event), models };
      if (timeOf(event) < since) spend.before = models;
    }

    if (!counted) continue;

    if (event.type === "hook-block") {
      const rules = (event.payload as { rules?: unknown } | null)?.rules;
      for (const rule of new Set(Array.isArray(rules) ? rules.filter(isText) : []))
        add(blocks, rule, 1);
    }

    const round = event.type === "round" ? roundFrom(event.payload) : undefined;
    if (!round || decisions.has(decisionKey(event, round))) continue;

    decisions.add(decisionKey(event, round));

    for (const [reviewer, outcome] of Object.entries(round.outcomes)) {
      const entry = reviewers.get(reviewer) ?? { reviewer, fixed: 0, dismissed: 0 };
      reviewers.set(reviewer, entry);
      entry[outcome] += 1;
    }
  }

  const closed = [...tracks.values()].filter(
    (track) =>
      track.done !== undefined &&
      CLOSED.includes(track.status) &&
      track.done >= since &&
      track.done <= now &&
      (filter.project === undefined || track.project === filter.project),
  );

  const measured = closed.map((track) => ({ track, phase: phases(track) }));
  const phaseMedians = Object.fromEntries(
    PHASES.map((name) => {
      const values = measured.flatMap(({ phase }) =>
        phase[name] === undefined ? [] : [phase[name]],
      );

      return [name, { median: median(values), count: values.length }];
    }),
  ) as Record<Phase, PhaseMedian>;

  const timed = measured.filter(
    ({ phase }) => phase.build !== undefined && phase.review !== undefined,
  );

  const efforts = timed.flatMap(({ track, phase }) => {
    const { effort, project, id } = track;
    if (!isEffort(effort)) return [];
    return [{ project, id, effort, elapsed: phase.build! + phase.review! }];
  });

  const shown = (project: string) => filter.project === undefined || project === filter.project;
  const tokens = tokenTallies(sessions, policies, since, shown);
  return {
    projects: [...projects].sort(byName),
    closed: closed.map(({ project, id, status }) => ({ project, id, status })),
    phases: phaseMedians,
    efforts: efforts.sort(
      (left, right) =>
        EFFORTS.indexOf(left.effort) - EFFORTS.indexOf(right.effort) ||
        left.elapsed - right.elapsed ||
        byName(`${left.project} ${left.id}`, `${right.project} ${right.id}`),
    ),
    unsized: timed.length - efforts.length,
    ...tokens,
    weeks: weekSpan(since, now).map((week) => ({
      week,
      launched: distinct(launched, week),
      closed: distinct(done, week),
    })),
    blocks: ranked(blocks),
    reviewers: [...reviewers.values()].sort((left, right) => byName(left.reviewer, right.reviewer)),
  };
}

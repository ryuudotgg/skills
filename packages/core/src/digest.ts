import { evalHistory, type EvalRun } from "./evals.ts";
import { foldRows, type DigestRecord, type PlanEvent } from "./events.ts";
import { revisionFrom } from "./plan.ts";
import {
  PHASES,
  silencedProjects,
  statsOf,
  timeOf,
  type PhaseMedian,
  type Stats,
} from "./stats.ts";
import { DAY_MS, durationText, isoWeek } from "./time.ts";
import { AD_HOC_ID } from "./trail.ts";

export const DIGEST_EVENT = "digest";

export const DIGEST_SECTIONS = [
  "Closes",
  "Phase times",
  "Came back from review",
  "Recurring hook blocks",
  "Slowest phase",
  "Token spend",
  "Eval regressions",
  "Lessons for /plans new",
] as const;

export type DigestSection = (typeof DIGEST_SECTIONS)[number];

const PLAN_SECTIONS: readonly string[] = [
  "Closes",
  "Came back from review",
  "Lessons for /plans new",
] satisfies DigestSection[];

export type WeekSpan = { week: string; start: number; end: number };

export type LandedLine = (revision: string) => string | undefined;

export type StoredDigest = DigestRecord & { ts: string; machine: string; final: boolean };

const WEEK_MS = 7 * DAY_MS;

const RECURRING_BLOCKS = 3;

const CAME_BACK_AFTER = 2;

const LESSON_REVIEWS = 2;

const WEEK = /^(\d{4})-W(\d{2})$/;

type Activity = {
  project: string;
  id: string;
  handedBack: boolean;
  reviews: number;
  reviewsAfterHandback: number;
  reviewedInWeek: boolean;
  activeInWeek: boolean;
  revision: string | undefined;
};

function byText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isoWeekSpan(at: number): WeekSpan {
  const date = new Date(at);
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const start = midnight - ((date.getUTCDay() + 6) % 7) * DAY_MS;
  return { week: isoWeek(start), start, end: start + WEEK_MS };
}

export function weekSpanOf(week: string): WeekSpan | undefined {
  const parts = WEEK.exec(week);
  if (!parts) return undefined;

  const fourth = Date.UTC(Number(parts[1]), 0, 4);
  const first = isoWeekSpan(fourth).start;
  const span = isoWeekSpan(first + (Number(parts[2]) - 1) * WEEK_MS);
  return span.week === week ? span : undefined;
}

export function digestFrom(payload: unknown): DigestRecord | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;

  const { week, markdown } = payload as Record<string, unknown>;
  if (typeof week !== "string" || !weekSpanOf(week) || typeof markdown !== "string")
    return undefined;

  return { week, markdown };
}

function owner(line: string, projects: ReadonlySet<string>): string | undefined {
  return [...projects]
    .filter((project) => {
      const rest = line.slice(`- ${project} `.length);
      return line.startsWith(`- ${project} `) && /^\d{3}(?:[ ,:]|$)/.test(rest);
    })
    .reduce<string | undefined>(
      (longest, project) =>
        longest === undefined || project.length > longest.length ? project : longest,
      undefined,
    );
}

function withheld(
  markdown: string,
  off: ReadonlySet<string>,
  projects: ReadonlySet<string>,
): string {
  if (off.size === 0) return markdown;

  const named = (line: string) => {
    const project = owner(line, projects);
    return project !== undefined && off.has(project);
  };

  const parts = markdown.split(/^(?=## )/m).map((part) => {
    const [heading = "", ...body] = part.trimEnd().split("\n");
    if (!PLAN_SECTIONS.includes(heading.slice(3))) return part.trimEnd();

    const items = body.filter((line) => line.startsWith("- "));
    const kept = items.filter((line) => !named(line));
    if (kept.length === items.length) return part.trimEnd();

    return [heading, "", ...(kept.length === 0 ? ["none"] : kept)].join("\n");
  });

  return `${parts.join("\n\n")}\n`;
}

export function digestsOf(events: Iterable<PlanEvent>): StoredDigest[] {
  const all = [...events];
  const off = silencedProjects(all);
  const projects = new Set(all.map((event) => event.project));
  const weeks = new Map<string, StoredDigest>();
  for (const event of all) {
    if (event.kind !== "stored" || event.type !== DIGEST_EVENT) continue;

    const record = digestFrom(event.payload);
    if (!record) continue;

    const final = Date.parse(event.ts) >= weekSpanOf(record.week)!.end;
    const held = weeks.get(record.week);
    const shown = { ...record, markdown: withheld(record.markdown, off, projects) };
    if (!held?.final)
      weeks.set(record.week, { ...shown, ts: event.ts, machine: event.machine, final });
  }

  return [...weeks.values()].sort((left, right) => byText(right.week, left.week));
}

function weekStats(events: readonly PlanEvent[], span: WeekSpan): Stats {
  return statsOf(events, span.end - 1, { days: 7, project: undefined });
}

function activities(events: readonly PlanEvent[], span: WeekSpan): Activity[] {
  const plans = new Map<string, Activity>();
  for (const event of events) {
    if (event.plan === AD_HOC_ID || event.kind === "row") continue;

    const key = `${event.project}\t${event.plan}`;
    const activity = plans.get(key) ?? {
      project: event.project,
      id: event.plan,
      handedBack: false,
      reviews: 0,
      reviewsAfterHandback: 0,
      reviewedInWeek: false,
      activeInWeek: false,
      revision: undefined,
    };

    plans.set(key, activity);

    if (event.kind === "stored") {
      const revision = event.type === "revision" ? revisionFrom(event.payload) : undefined;
      if (revision) activity.revision = revision.sha256;
      continue;
    }

    const inWeek = timeOf(event) >= span.start && timeOf(event) < span.end;
    activity.activeInWeek ||= inWeek;
    if (event.type === "handback") activity.handedBack = true;
    if (event.type !== "review") continue;

    activity.reviews += 1;
    activity.reviewedInWeek ||= inWeek;
    if (activity.handedBack) activity.reviewsAfterHandback += 1;
  }

  return [...plans.values()].sort(
    (left, right) => byText(left.project, right.project) || byText(left.id, right.id),
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function medianText(phase: PhaseMedian): string {
  return phase.median === undefined
    ? "none"
    : `${durationText(phase.median)} over ${plural(phase.count, "plan")}`;
}

function outcome({ result, record }: EvalRun): string {
  const exit = record.exit === 0 ? [] : [`exit ${record.exit}`];
  return [result, ...exit, ...(record.grade === null ? [] : [record.grade])].join(", ");
}

function sectionText(title: DigestSection, lines: readonly string[]): string {
  const body = lines.length === 0 ? "none" : lines.map((line) => `- ${line}`).join("\n");
  return `## ${title}\n\n${body}\n`;
}

export function digestOf(
  events: Iterable<PlanEvent>,
  at: number,
  landed: LandedLine,
): DigestRecord {
  const span = isoWeekSpan(at);
  const prior = isoWeekSpan(span.start - 1);
  const known = [...events].filter((event) => event.wall < span.end);
  const off = silencedProjects(known);
  const kept = known.filter((event) => !off.has(event.project));

  const slugs = new Map<string, string>();
  for (const [project, rows] of foldRows(kept))
    for (const row of rows.values()) slugs.set(`${project}\t${row.id}`, row.slug);

  const named = (project: string, id: string) => {
    const slug = slugs.get(`${project}\t${id}`);
    return slug === undefined ? `${project} ${id}` : `${project} ${id} ${slug}`;
  };

  const week = weekStats(known, span);
  const before = weekStats(
    known.filter((event) => event.wall < prior.end),
    prior,
  );

  const plans = activities(kept, span);
  const closed = week.closed.toSorted((left, right) =>
    byText(named(left.project, left.id), named(right.project, right.id)),
  );

  const dropped = new Set(
    closed
      .filter(({ status }) => status === "DROPPED")
      .map(({ project, id }) => `${project}\t${id}`),
  );

  const slowest = PHASES.flatMap((phase) => {
    const { median } = week.phases[phase];
    return median === undefined ? [] : [{ phase, median }];
  }).reduce<{ phase: string; median: number } | undefined>(
    (worst, next) => (worst === undefined || next.median > worst.median ? next : worst),
    undefined,
  );

  const regressions = evalHistory(kept, { kind: "all" })
    .flatMap((entry) => entry.runs.map((run) => ({ name: entry.name, run })))
    .filter(({ run }) => run.regressed && Date.parse(run.ts) >= span.start)
    .sort((left, right) => byText(left.run.ts, right.run.ts) || byText(left.name, right.name));

  const sections: Record<DigestSection, string[]> = {
    Closes: closed.map(
      ({ project, id, status }) =>
        `${named(project, id)}${status === "DROPPED" ? ", dropped" : ""}`,
    ),
    "Phase times": PHASES.map(
      (phase) =>
        `${phase} ${medianText(week.phases[phase])}, prior week ${medianText(before.phases[phase])}`,
    ),
    "Came back from review": plans
      .filter((plan) => plan.reviewedInWeek && plan.reviewsAfterHandback > CAME_BACK_AFTER)
      .map((plan) => named(plan.project, plan.id)),
    "Recurring hook blocks": week.blocks
      .filter((block) => block.value >= RECURRING_BLOCKS)
      .map((block) => `${block.name} ${plural(block.value, "block")}`),
    "Slowest phase": slowest ? [`${slowest.phase}, median ${durationText(slowest.median)}`] : [],
    "Token spend": week.models.map((model) => `${model.name} ${model.value} tokens`),
    "Eval regressions": regressions.map(({ name, run }) => `${name} ${run.ts} ${outcome(run)}`),
    "Lessons for /plans new": plans
      .filter(
        (plan) =>
          (plan.activeInWeek && plan.reviews >= LESSON_REVIEWS) ||
          dropped.has(`${plan.project}\t${plan.id}`),
      )
      .map((plan) => {
        const line = plan.revision === undefined ? undefined : landed(plan.revision);
        return `${named(plan.project, plan.id)}: ${line ?? "-"}`;
      }),
  };

  const markdown = DIGEST_SECTIONS.map((title) => sectionText(title, sections[title])).join("\n");
  return { week: span.week, markdown };
}

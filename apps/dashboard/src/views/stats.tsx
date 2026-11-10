import { useId, useMemo, useState, type ReactNode } from "react";
import {
  EFFORTS,
  PHASES,
  STATS_WINDOWS,
  durationText,
  statsOf,
  type EffortMark,
  type Phase,
  type PlanEvent,
  type ReviewerCount,
  type Stats,
  type StatsFilter,
  type Tally,
  type WeekCount,
} from "skills-core";
import type { View, ViewProps } from "../view.ts";

const EMPTY = "no stats";

const REVIEW_NOTE = "outcomes per decision, not finding counts";

const PHASE_NAMES: Record<Phase, string> = { queue: "Queue", build: "Build", review: "Review" };

const CHART_WIDTH = 320;

const BAR_HEIGHT = 8;

const AXIS_PITCH = 20;

const BAR_PITCH = 30;

const DOT_PITCH = 30;

const DOT_RIGHT = CHART_WIDTH - 6;

const LABEL_LIMIT = 44;

const TEXT = { fill: "var(--chart-text)" };

const SERIES = { launched: "var(--chart-1)", closed: "var(--chart-2)" } as const;

export type StatsBoardProps = {
  events: readonly PlanEvent[];
  now: number;
  filter: StatsFilter;
  onFilter?: (filter: StatsFilter) => void;
};

function timeText(milliseconds: number | undefined): string {
  return milliseconds === undefined ? "-" : durationText(milliseconds);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function Section({
  name,
  title,
  aside,
  children,
}: {
  name: string;
  title: string;
  aside?: string;
  children: ReactNode;
}) {
  const note = useId();
  return (
    <section
      data-section={name}
      aria-describedby={aside === undefined ? undefined : note}
      className="flex min-w-0 flex-col gap-2"
    >
      <div className="flex flex-col">
        <h2 className="text-base font-semibold">{title}</h2>
        {aside === undefined ? null : (
          <p id={note} className="text-sm text-ink-secondary">
            {aside}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}

function Note({ children }: { children: string }) {
  return <p className="text-sm text-ink-secondary">{children}</p>;
}

function withSelected(projects: readonly string[], selected: string | undefined): string[] {
  return selected === undefined || projects.includes(selected)
    ? [...projects]
    : [...projects, selected];
}

type ControlsProps = Pick<StatsBoardProps, "filter" | "onFilter"> & {
  projects: readonly string[];
};

function Controls({ projects, filter, onFilter }: ControlsProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
      <fieldset className="flex items-center gap-2">
        <legend className="sr-only">Window</legend>
        <span aria-hidden="true" className="text-sm text-ink-secondary">
          Window
        </span>
        <div className="flex rounded border border-hairline">
          {STATS_WINDOWS.map((days) => (
            <label
              key={days}
              className="cursor-pointer px-2 py-1 text-sm text-ink-secondary tabular-nums not-first:border-l not-first:border-hairline has-checked:bg-surface has-checked:font-medium has-checked:text-ink has-focus-visible:outline-2 has-focus-visible:outline-focus"
            >
              <input
                type="radio"
                name="window"
                value={days}
                checked={filter.days === days}
                onChange={() => onFilter?.({ ...filter, days })}
                className="sr-only"
              />
              {days} days
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex min-w-0 items-center gap-2 text-sm text-ink-secondary">
        Project
        <select
          value={filter.project ?? ""}
          onChange={(event) => {
            const project = event.currentTarget.value;
            onFilter?.({ ...filter, project: project === "" ? undefined : project });
          }}
          className="max-w-48 min-w-0 truncate rounded border border-hairline bg-surface px-2 py-1 text-ink focus:outline-2 focus:outline-focus"
        >
          <option value="">All projects</option>
          {withSelected(projects, filter.project).map((project) => (
            <option key={project} value={project}>
              {project}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function Tiles({ stats }: { stats: Stats }) {
  return (
    <section data-section="phases" aria-label="Phase medians" className="flex flex-col gap-2">
      <dl className="grid grid-cols-3 divide-x divide-hairline border-y border-hairline">
        {PHASES.map((phase) => (
          <div key={phase} data-tile={phase} className="flex flex-col gap-1 px-3 py-3 first:pl-0">
            <dt className="text-sm text-ink-secondary">{PHASE_NAMES[phase]}</dt>
            <dd className="text-lg font-medium tabular-nums sm:text-xl">
              {timeText(stats.phases[phase].median)}
            </dd>
            <dd className="text-xs text-ink-muted">
              median of {plural(stats.phases[phase].count, "plan")}
            </dd>
          </div>
        ))}
      </dl>
      <Note>
        Plans closed in the window. Queue runs from added to the first start, build from each start
        to its handback, review from the first handback to done.
      </Note>
    </section>
  );
}

type Bar = { text: string; mark: string; title: string; value: number; colour: string };

type Line = { kind: "axis"; text: string } | ({ kind: "bar" } & Bar);

function bar(fields: Pick<Bar, "text" | "value"> & Partial<Bar>): Line {
  const { text, colour = "var(--chart-1)", mark = text, title = mark } = fields;
  return { kind: "bar", ...fields, colour, mark, title };
}

function widthOf(character: string): number {
  return (character.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1;
}

function widthText(text: string): number {
  return [...text].reduce((sum, character) => sum + widthOf(character), 0);
}

function labelled(name: string, suffix: string, limit = LABEL_LIMIT): string {
  return `${clipped(name, limit - widthText(suffix))}${suffix}`;
}

function clipped(name: string, limit: number): string {
  const characters = [...name];
  if (widthText(name) <= limit) return name;

  let kept = "";
  let width = 3;
  for (const character of characters) {
    width += widthOf(character);
    if (width > limit) break;
    kept += character;
  }

  return `${kept}...`;
}

function Bars({ label, lines }: { label: string; lines: readonly Line[] }) {
  const max = Math.max(1, ...lines.map((line) => (line.kind === "bar" ? line.value : 0)));
  let y = 0;

  const drawn = lines.map((line, index) => {
    const top = y;
    if (line.kind === "axis") {
      y += AXIS_PITCH;
      return (
        <text key={index} data-axis="" x={0} y={top + 14} fontSize={12} style={TEXT}>
          {line.text}
        </text>
      );
    }

    y += BAR_PITCH;
    return (
      <g key={index}>
        <title>{line.title}</title>
        <text data-label="" x={0} y={top + 12} fontSize={12} className="tabular-nums" style={TEXT}>
          {line.text}
        </text>
        <rect
          data-mark={line.mark}
          x={0}
          y={top + 17}
          width={Math.max(2, (line.value / max) * CHART_WIDTH)}
          height={BAR_HEIGHT}
          rx={2}
          style={{ fill: line.colour }}
        />
      </g>
    );
  });

  return (
    <svg
      width={CHART_WIDTH}
      height={y}
      viewBox={`0 0 ${CHART_WIDTH} ${y}`}
      aria-label={label}
      className="h-auto max-w-full"
    >
      {drawn}
    </svg>
  );
}

function tallyLines(tallies: readonly Tally[]): Line[] {
  return tallies.map(({ name, value }) =>
    bar({ text: labelled(name, ` ${value}`), value, title: `${name} ${value}` }),
  );
}

function weekLines(weeks: readonly WeekCount[]): Line[] {
  return weeks.flatMap(({ week, launched, closed }) => {
    const lines: Line[] = [{ kind: "axis", text: launched + closed === 0 ? `${week} none` : week }];
    if (launched > 0)
      lines.push(
        bar({
          text: `launched ${launched}`,
          value: launched,
          colour: SERIES.launched,
          mark: `${week} launched ${launched}`,
        }),
      );

    if (closed > 0)
      lines.push(
        bar({
          text: `closed ${closed}`,
          value: closed,
          colour: SERIES.closed,
          mark: `${week} closed ${closed}`,
        }),
      );

    return lines;
  });
}

function dotLabel(mark: EffortMark, limit = LABEL_LIMIT): string {
  return labelled(mark.project, ` ${mark.id} ${mark.effort} ${durationText(mark.elapsed)}`, limit);
}

function Dots({ marks }: { marks: readonly EffortMark[] }) {
  const max = Math.max(1, ...marks.map((mark) => mark.elapsed));
  let y = 0;

  const bands = EFFORTS.map((effort) => {
    const band = marks.filter((mark) => mark.effort === effort);
    if (band.length === 0) return null;

    const top = y;
    y += AXIS_PITCH;

    const rows = band.map((mark) => {
      const line = y + 21;
      const text = y + 12;
      y += DOT_PITCH;
      return (
        <g key={`${mark.project} ${mark.id}`}>
          <title>{dotLabel(mark, Infinity)}</title>
          <text data-label="" x={0} y={text} fontSize={11} style={TEXT}>
            {dotLabel(mark)}
          </text>
          <line
            x1={0}
            x2={DOT_RIGHT}
            y1={line}
            y2={line}
            strokeWidth={1}
            style={{ stroke: "var(--chart-grid)" }}
          />
          <circle
            data-mark={dotLabel(mark)}
            cx={4 + (mark.elapsed / max) * (DOT_RIGHT - 4)}
            cy={line}
            r={4}
            style={{ fill: "var(--chart-1)" }}
          />
        </g>
      );
    });

    return (
      <g key={effort} data-effort={effort}>
        <text data-axis="" x={0} y={top + 14} fontSize={12} fontWeight={600} style={TEXT}>
          {effort}
        </text>
        {rows}
      </g>
    );
  });

  return (
    <svg
      width={CHART_WIDTH}
      height={y}
      viewBox={`0 0 ${CHART_WIDTH} ${y}`}
      aria-label={`${plural(marks.length, "closed plan")} by effort, build plus review time`}
      className="h-auto max-w-full"
    >
      {bands}
    </svg>
  );
}

function Reviewers({ reviewers }: { reviewers: readonly ReviewerCount[] }) {
  return (
    <table className="w-full max-w-sm text-left text-sm">
      <thead className="text-ink-secondary">
        <tr className="border-b border-hairline">
          <th scope="col" className="py-1 pr-4 font-normal">
            Reviewer
          </th>
          <th scope="col" className="py-1 pr-4 text-right font-normal">
            Fixed
          </th>
          <th scope="col" className="py-1 text-right font-normal">
            Dismissed
          </th>
        </tr>
      </thead>
      <tbody>
        {reviewers.map((row) => (
          <tr key={row.reviewer} data-reviewer={row.reviewer} className="border-b border-hairline">
            <td className="py-1 pr-4">{row.reviewer}</td>
            <td className="py-1 pr-4 text-right tabular-nums">{row.fixed}</td>
            <td className="py-1 text-right tabular-nums">{row.dismissed}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Effort({ stats }: { stats: Stats }) {
  const unsized =
    stats.unsized === 0 ? null : (
      <Note>{`${plural(stats.unsized, "plan")} without an effort`}</Note>
    );

  return (
    <Section name="effort" title="Effort against build plus review time">
      {stats.efforts.length === 0 ? (
        <Note>no closed plans with an effort size, build and review times in this window</Note>
      ) : (
        <Dots marks={stats.efforts} />
      )}
      {unsized}
    </Section>
  );
}

export function StatsBoard({ events, now, filter, onFilter }: StatsBoardProps) {
  const stats = useMemo(() => statsOf(events, now, filter), [events, now, filter]);
  if (events.length === 0) return <p className="text-ink-secondary">{EMPTY}</p>;

  const opened = stats.weeks.some((week) => week.launched + week.closed > 0);
  return (
    <div className="flex flex-col gap-8">
      <Controls projects={stats.projects} filter={filter} onFilter={onFilter} />
      <Tiles stats={stats} />
      <div className="grid gap-8 lg:grid-cols-2">
        <Effort stats={stats} />
        <Section name="throughput" title="Plans per week" aside="launched by wave, closed">
          {opened ? (
            <Bars label="Plans launched and closed per ISO week" lines={weekLines(stats.weeks)} />
          ) : (
            <Note>no plans launched or closed in this window</Note>
          )}
        </Section>
        <Section name="models" title="Tokens per model" aside="in plus out">
          {stats.models.length === 0 ? (
            <Note>no session tokens in this window</Note>
          ) : (
            <Bars label="Tokens per model" lines={tallyLines(stats.models)} />
          )}
        </Section>
        <Section
          name="plans"
          title="Tokens per plan"
          aside="a session naming several plans counts in full toward each"
        >
          {stats.plans.length === 0 ? (
            <Note>no session tokens in this window</Note>
          ) : (
            <Bars label="Tokens per plan" lines={tallyLines(stats.plans)} />
          )}
        </Section>
        <Section name="blocks" title="Hook blocks per rule">
          {stats.blocks.length === 0 ? (
            <Note>no hook blocks in this window</Note>
          ) : (
            <Bars label="Hook blocks per rule id" lines={tallyLines(stats.blocks)} />
          )}
        </Section>
        <Section name="reviewers" title="Reviewer outcomes" aside={REVIEW_NOTE}>
          {stats.reviewers.length === 0 ? (
            <Note>no review rounds in this window</Note>
          ) : (
            <Reviewers reviewers={stats.reviewers} />
          )}
        </Section>
      </div>
    </div>
  );
}

function StatsView({ scene }: ViewProps) {
  const [filter, setFilter] = useState<StatsFilter>({ days: 30, project: undefined });
  return <StatsBoard events={scene.events} now={scene.now} filter={filter} onFilter={setFilter} />;
}

export const stats: View = { name: "Stats", path: "/stats", empty: EMPTY, Component: StatsView };

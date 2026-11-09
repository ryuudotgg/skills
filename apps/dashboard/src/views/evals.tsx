import { useMemo, useState, type ReactElement } from "react";
import {
  evalChoices,
  evalHistory,
  machineLabel,
  machineLabels,
  type EvalCase,
  type EvalChoices,
  type EvalFilter,
  type EvalResult,
  type EvalRun,
  type PlanEvent,
} from "skills-core";
import { durationText } from "../duration.ts";
import type { View, ViewProps } from "../view.ts";

const EMPTY = "no eval runs";

const ACCENT = "var(--chart-accent)";

const NEUTRAL = "var(--chart-neutral)";

const MARKS: Record<EvalResult, ReactElement> = {
  pass: <circle cx="6" cy="6" r="5" style={{ fill: NEUTRAL }} />,
  fail: <rect x="1" y="1" width="10" height="10" style={{ fill: ACCENT }} />,
  ungraded: (
    <circle cx="6" cy="6" r="4.25" style={{ fill: "none", stroke: NEUTRAL, strokeWidth: 1.5 }} />
  ),
};

const COLUMNS = ["Time", "Models", "Roster", "Exit", "Result", "Grade", "Duration", "Machine"];

export type EvalHistoryProps = {
  events: readonly PlanEvent[];
  filter: EvalFilter;
  onFilter?: (filter: EvalFilter) => void;
};

function filterValue(filter: EvalFilter): string {
  if (filter.kind === "model") return `model:${filter.model}`;
  if (filter.kind === "roster") return `roster:${filter.roster}`;
  return "";
}

function filterOf(value: string): EvalFilter {
  const split = value.indexOf(":");
  const kind = value.slice(0, split);
  const name = value.slice(split + 1);
  if (split > 0 && kind === "model") return { kind, model: name };
  if (split > 0 && kind === "roster") return { kind, roster: name };

  return { kind: "all" };
}

function withSelected(names: readonly string[], selected: string | undefined): string[] {
  return selected === undefined || names.includes(selected) ? [...names] : [...names, selected];
}

function orDash(text: string): string {
  return text === "" ? "-" : text;
}

function Regressed() {
  return (
    <span className="text-sm font-medium" style={{ color: ACCENT }}>
      regressed
    </span>
  );
}

type PickerProps = {
  choices: EvalChoices;
  filter: EvalFilter;
  onFilter: EvalHistoryProps["onFilter"];
};

function Picker({ choices, filter, onFilter }: PickerProps) {
  const models = withSelected(choices.models, filter.kind === "model" ? filter.model : undefined);
  const rosters = withSelected(
    choices.rosters,
    filter.kind === "roster" ? filter.roster : undefined,
  );

  return (
    <label className="flex max-w-full min-w-0 items-center gap-2 text-sm text-ink-secondary">
      Show
      <select
        value={filterValue(filter)}
        onChange={(event) => onFilter?.(filterOf(event.currentTarget.value))}
        className="w-full max-w-sm min-w-0 truncate rounded border border-hairline bg-surface px-2 py-1 text-ink focus:outline-2 focus:outline-focus"
      >
        <option value="">every run</option>
        <optgroup label="Model">
          {models.map((model) => (
            <option key={model} value={`model:${model}`}>
              {model}
            </option>
          ))}
        </optgroup>
        <optgroup label="Roster">
          {rosters.map((roster) => (
            <option key={roster} value={`roster:${roster}`}>
              {orDash(roster)}
            </option>
          ))}
        </optgroup>
      </select>
    </label>
  );
}

function Strip({ runs }: { runs: readonly EvalRun[] }) {
  return (
    <ol aria-label="Results, oldest first" className="flex flex-wrap gap-x-3 gap-y-1">
      {runs.toReversed().map((run, index) => (
        <li
          key={`${run.ts} ${run.machine} ${index}`}
          data-result={run.result}
          title={`${run.ts} ${run.result}`}
          className="flex items-center gap-1 text-xs text-ink-secondary"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            {MARKS[run.result]}
          </svg>
          {run.result}
        </li>
      ))}
    </ol>
  );
}

function Result({ run }: { run: EvalRun }) {
  const text =
    run.result === "fail" ? <span style={{ color: ACCENT }}>fail</span> : <span>{run.result}</span>;

  return (
    <span className="flex items-baseline gap-2">
      {text}
      {run.regressed ? <Regressed /> : null}
    </span>
  );
}

function Runs({ runs, labels }: { runs: readonly EvalRun[]; labels: ReadonlyMap<string, string> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-ink-secondary">
          <tr className="border-b border-hairline">
            {COLUMNS.map((column) => (
              <th key={column} scope="col" className="py-1 pr-4 font-normal whitespace-nowrap">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {runs.map((run, index) => (
            <tr key={`${run.ts} ${run.machine} ${index}`} className="border-b border-hairline">
              <td className="py-1 pr-4 font-mono whitespace-nowrap tabular-nums">
                <time dateTime={run.ts}>{run.ts}</time>
              </td>
              <td className="py-1 pr-4">{orDash(run.record.models.join(" "))}</td>
              <td className="py-1 pr-4">{orDash(run.record.roster)}</td>
              <td className="py-1 pr-4 font-mono tabular-nums">{run.record.exit}</td>
              <td className="py-1 pr-4">
                <Result run={run} />
              </td>
              <td className="py-1 pr-4 font-mono whitespace-nowrap">{run.record.grade ?? "-"}</td>
              <td className="py-1 pr-4 whitespace-nowrap tabular-nums">
                {durationText(run.record.duration)}
              </td>
              <td className="py-1 pr-4">{machineLabel(labels, run.machine)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Case({ entry, labels }: { entry: EvalCase; labels: ReadonlyMap<string, string> }) {
  return (
    <section data-case={entry.name} className="flex flex-col gap-3">
      <h2 className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono font-medium">{entry.name}</span>
        {entry.regressed ? <Regressed /> : null}
      </h2>
      <Strip runs={entry.runs} />
      <Runs runs={entry.runs} labels={labels} />
    </section>
  );
}

export function EvalHistory({ events, filter, onFilter }: EvalHistoryProps) {
  const choices = useMemo(() => evalChoices(events), [events]);
  const cases = useMemo(() => evalHistory(events, filter), [events, filter]);
  const labels = useMemo(() => machineLabels(events), [events]);
  if (choices.rosters.length === 0) return <p className="text-ink-secondary">{EMPTY}</p>;

  return (
    <div className="flex flex-col gap-8">
      <Picker choices={choices} filter={filter} onFilter={onFilter} />
      {cases.length === 0 ? (
        <p className="text-ink-secondary">no runs match this filter</p>
      ) : (
        cases.map((entry) => <Case key={entry.name} entry={entry} labels={labels} />)
      )}
    </div>
  );
}

function EvalsView({ scene }: ViewProps) {
  const [filter, setFilter] = useState<EvalFilter>({ kind: "all" });
  return <EvalHistory events={scene.events} filter={filter} onFilter={setFilter} />;
}

export const evals: View = {
  name: "Eval history",
  path: "/evals",
  empty: EMPTY,
  Component: EvalsView,
};

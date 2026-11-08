import type { EvalRecord, PlanEvent } from "./events.ts";

export type EvalResult = "pass" | "fail" | "ungraded";

export type EvalFilter =
  | { kind: "all" }
  | { kind: "model"; model: string }
  | { kind: "roster"; roster: string };

export type EvalRun = {
  record: EvalRecord;
  ts: string;
  machine: string;
  result: EvalResult;
  regressed: boolean;
};

export type EvalCase = { name: string; runs: EvalRun[]; regressed: boolean };

export type EvalChoices = { models: string[]; rosters: string[] };

type Recorded = Omit<EvalRun, "regressed">;

function fields(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isVerdict(value: unknown): value is EvalRecord["verdict"] {
  return value === "pass" || value === "fail" || value === null;
}

export function evalFrom(payload: unknown): EvalRecord | undefined {
  const record = fields(payload);
  if (!record) return undefined;

  const { case: name, models, roster, exit, verdict, grade, duration } = record;
  if (!isText(name) || !Array.isArray(models) || !models.every(isText)) return undefined;
  if (typeof roster !== "string" || !Number.isInteger(exit) || !isVerdict(verdict))
    return undefined;

  if (grade !== null && typeof grade !== "string") return undefined;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) return undefined;

  return { case: name, models, roster, exit: exit as number, verdict, grade, duration };
}

export function evalResult(record: EvalRecord): EvalResult {
  if (record.exit !== 0) return "fail";
  return record.verdict ?? "ungraded";
}

function recordedRuns(events: Iterable<PlanEvent>): Recorded[] {
  const runs: Recorded[] = [];
  for (const event of events) {
    if (event.kind !== "stored" || event.type !== "eval") continue;

    const record = evalFrom(event.payload);
    if (record)
      runs.push({ record, ts: event.ts, machine: event.machine, result: evalResult(record) });
  }

  return runs;
}

function kept(filter: EvalFilter, record: EvalRecord): boolean {
  if (filter.kind === "model") return record.models.includes(filter.model);
  if (filter.kind === "roster") return record.roster === filter.roster;
  return true;
}

export function evalChoices(events: Iterable<PlanEvent>): EvalChoices {
  const runs = recordedRuns(events);
  const models = new Set(runs.flatMap(({ record }) => record.models));
  const rosters = new Set(runs.map(({ record }) => record.roster));
  return { models: [...models].sort(), rosters: [...rosters].sort() };
}

export function evalHistory(events: Iterable<PlanEvent>, filter: EvalFilter): EvalCase[] {
  const cases = new Map<string, EvalRun[]>();
  for (const run of recordedRuns(events)) {
    if (!kept(filter, run.record)) continue;

    const runs = cases.get(run.record.case) ?? [];
    const regressed = run.result === "fail" && runs.at(-1)?.result === "pass";

    cases.set(run.record.case, runs);
    runs.push({ ...run, regressed });
  }

  return [...cases]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, runs]) => ({
      name,
      runs: runs.toReversed(),
      regressed: runs.some((run) => run.regressed),
    }));
}

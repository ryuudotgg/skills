import { object, type RecordObject } from "../sessions/jsonl.ts";
import { fixed, sum } from "./numbers.ts";

export const digestKey = "AUDIT_DIGEST";

type Kind = "time" | "count" | "share";
type Field = { key: string; kind: Kind; value: (run: RecordObject) => number | undefined };
type Verdict = "flag" | "ok" | "new" | "gone";

const relativeThreshold = 0.25;
const shareThreshold = 5;
const tolerance = 1e-9;

function at(run: RecordObject, path: readonly string[]): unknown {
  let value: unknown = run;
  for (const key of path) value = object(value) ? value[key] : undefined;
  return value;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function keysAt(runs: readonly RecordObject[], path: readonly string[]): string[] {
  const keys = runs.flatMap((run) => {
    const value = at(run, path);
    return object(value) ? Object.keys(value) : [];
  });

  return [...new Set(keys)];
}

function xhighRuns(run: RecordObject): number | undefined {
  const groups = at(run, ["codex", "groups"]);
  if (!Array.isArray(groups)) return undefined;

  return sum(
    groups
      .filter((group) => object(group) && group.effort === "xhigh")
      .map((group) => finite((group as RecordObject).n) ?? 0),
  );
}

function followUpShares(run: RecordObject): Map<string, number> {
  const rows = at(run, ["follow_up_fixes", "rows"]);
  const shares = new Map<string, number>();
  if (!Array.isArray(rows)) return shares;

  for (const row of rows) {
    const share = object(row) ? finite(row.share) : undefined;
    if (object(row) && typeof row.implementer === "string" && share !== undefined)
      shares.set(row.implementer, share * 100);
  }

  return shares;
}

function fields(runs: readonly RecordObject[]): Field[] {
  const path =
    (...keys: string[]) =>
    (run: RecordObject) =>
      finite(at(run, keys));

  const implementers = [...new Set(runs.flatMap((run) => [...followUpShares(run).keys()]))];
  return [
    { key: "tasks.median_minutes", kind: "time", value: path("tasks", "median_minutes") },
    ...keysAt(runs, ["tasks", "by_effort"]).map((effort): Field => ({
      key: `tasks.by_effort.${effort}.median_minutes`,
      kind: "time",
      value: path("tasks", "by_effort", effort, "median_minutes"),
    })),
    {
      key: "windows.median_tail_seconds",
      kind: "time",
      value: path("windows", "median_tail_seconds"),
    },
    ...keysAt(runs, ["windows", "shares_percent"]).map((phase): Field => ({
      key: `windows.shares_percent.${phase}`,
      kind: "share",
      value: path("windows", "shares_percent", phase),
    })),
    { key: "codex.xhigh_runs", kind: "count", value: xhighRuns },
    ...implementers.map((implementer): Field => ({
      key: `follow_up_fixes.${implementer}.share_percent`,
      kind: "share",
      value: (run) => followUpShares(run).get(implementer),
    })),
  ];
}

function signed(value: number, unit: string): string {
  const text = fixed(value);
  return `${text.startsWith("-") ? "" : "+"}${text}${unit}`;
}

function line(field: Field, old: number | undefined, current: number | undefined): string {
  const row = (verdict: Verdict, text: string) => `${verdict.padEnd(4)}  ${field.key}  ${text}`;
  const shown = (value: number | undefined) =>
    value === undefined ? "none" : field.kind === "count" ? String(value) : fixed(value);

  if (current === undefined) return row("gone", `${shown(old)} to none`);
  if (old === 0 && current === 0) return row("ok", `${shown(old)} to ${shown(current)}`);
  if (old === undefined || old === 0 || (field.kind !== "share" && old < 0))
    return row("new", `${shown(old)} to ${shown(current)}`);

  const rise = field.kind === "share" ? current - old : (current - old) / old;
  const threshold = field.kind === "share" ? shareThreshold : relativeThreshold;
  const change = field.kind === "share" ? signed(rise, " pp") : signed(rise * 100, "%");
  return row(
    rise >= threshold - tolerance ? "flag" : "ok",
    `${shown(old)} to ${shown(current)}, ${change}`,
  );
}

export function compareRuns(old: RecordObject, current: RecordObject): string {
  const rows = fields([old, current]).flatMap((field) => {
    const before = field.value(old);
    const after = field.value(current);
    return before === undefined && after === undefined ? [] : [line(field, before, after)];
  });

  const notes = ["tasks", "windows", "codex", "follow_up_fixes"].flatMap((section) => {
    const values = at(current, [section, "notes"]);
    return Array.isArray(values) ? values.filter((value) => typeof value === "string") : [];
  });

  const flagged = rows.filter((row) => row.startsWith("flag")).length;
  const stamp = (run: RecordObject) =>
    typeof run.generated_at === "string" ? run.generated_at : "unknown time";

  return [
    `Audit compare, ${stamp(old)} to ${stamp(current)}`,
    ...rows,
    `${flagged} flagged`,
    ...notes.map((message) => `Note: ${message}`),
  ].join("\n");
}

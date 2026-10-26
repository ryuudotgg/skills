import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { ghOutput } from "../gh.ts";
import { processIo } from "../io.ts";
import { read } from "../read.ts";
import { followUps, type FollowUpRow } from "./follow-ups.ts";
import { boundary, codexArm, toolName, word } from "./transcript.ts";
import { compareRuns } from "./compare.ts";
import { indexIn, plansDir, readIndexTolerant } from "../plans/index-tsv.ts";
import { AD_HOC_ID, readTrailTolerant, trailIn } from "../plans/trail.ts";
import { checkoutRoots, repositoryStore } from "../sessions/checkouts.ts";
import { extractedText, readSubagents, readTranscripts } from "../sessions/claude.ts";
import type { SessionStore, Subagent, TranscriptEvent } from "../sessions/claude.ts";
import { readCodexRuns } from "../sessions/codex.ts";
import type { CodexRun } from "../sessions/codex.ts";
import {
  childPath,
  directoryEntries,
  earliestMicros,
  isDirectory,
  note,
  object,
  parseTimestamp,
} from "../sessions/jsonl.ts";
import type { Notes, RecordObject } from "../sessions/jsonl.ts";
import { colorEnabled } from "../terminal.ts";
import { fixed, round, sum } from "./numbers.ts";
import { prettyReport } from "./report.ts";

export { encodedProjectDir } from "../sessions/claude.ts";

const plansDo = new RegExp(
  `/plans\\s+do${boundary}|plans</command-name>\\s*<command-args>\\s*do${boundary}`,
  "u",
);

const backgroundTask = new RegExp(`Command running in background with ID: (${word}+)`, "u");
const notifiedTask = new RegExp(`<task-id>(${word}+)</task-id>`, "u");
const notifiedToolUse = /<tool-use-id>([^<]+)<\/tool-use-id>/u;
const blankText = /^\s*$/u;

const efforts = ["XS", "S", "M", "L", "unknown"] as const;
const histogramBins: readonly (readonly [string, number])[] = [
  ["<10m", 10],
  ["10-20m", 20],
  ["20-30m", 30],
  ["30-45m", 45],
  ["45-60m", 60],
  ["60-120m", 120],
  [">120m", Infinity],
];

const editTools = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const spawnTools = new Set(["Agent", "Task"]);
const reviewOnlyAgents = new Set(["codex-reviewer", "comment-sicko", "Explore", "Plan"]);

type Task = { project: string; taskId: string; effort: string; startedAt: number; endedAt: number };
type Window = { prompt: string; events: TranscriptEvent[] };
type Interval = readonly [number, number];
type Metrics = {
  duration_s: number;
  to_first_edit_s: number | null;
  tail_s: number | null;
  model_s: number;
  bash_s: number;
  question_s: number;
  subagent_wait_s: number;
  codex_wait_s: number;
};

type Output = { code: number; stdout: string; stderr: string };
type Options = {
  env: NodeJS.ProcessEnv;
  now: Date;
  cwd: string;
  terminal?: { width: number };
  gh?: (args: readonly string[]) => Promise<string | undefined>;
  git?: (args: readonly string[]) => Promise<string | undefined>;
};

type Arguments = {
  days: number;
  json: boolean;
  prs: boolean;
  projectDir: string | undefined;
  compare: { old: string; current: string | undefined } | undefined;
  digest: boolean;
};

type Cell = string | number | null;

const cherokee = /[Ꭰ-Ᏽᏸ-ᏽꭰ-ꮿ]/u;

export function casefold(value: string): string {
  return [...value]
    .map((character) => {
      if (character === "ı") return character;
      if (character === "ẞ") return "ss";
      if (cherokee.test(character)) return character.toUpperCase();

      return character.toUpperCase().toLowerCase();
    })
    .join("");
}

function taskKey(project: string, taskId: string): string {
  return JSON.stringify([casefold(project), taskId]);
}

function effortIndex(plansDir: string, notes: Notes): Map<string, string> {
  const index = new Map<string, string>();

  let projects: string[];
  try {
    projects = directoryEntries(plansDir);
  } catch {
    note(notes, `${plansDir} is unavailable`);
    return index;
  }

  for (const project of projects) {
    const directory = childPath(plansDir, project);
    if (!isDirectory(directory)) continue;

    const path = indexIn(directory);
    const table = readIndexTolerant(path);
    if (table.kind === "absent") continue;
    if (table.kind === "failed") {
      note(notes, `${path} is unavailable`);
      continue;
    }

    for (const row of table.rows)
      if (typeof row.id === "string" && typeof row.effort === "string")
        index.set(taskKey(project, row.id), row.effort);
  }

  return index;
}

function readTasks(plansDir: string, cutoff: number, notes: Notes): Task[] {
  const index = effortIndex(plansDir, notes);
  const opened = new Map<string, number>();
  const tasks: Task[] = [];
  const terminal = new Set(["handback", "handoff", "handover", "done"]);

  const path = trailIn(plansDir);
  const table = readTrailTolerant(path);
  if (table.kind !== "rows") {
    note(notes, `${path} is unavailable`);
    return tasks;
  }

  for (const row of table.rows) {
    const timestamp = parseTimestamp(row.ts);
    if (
      timestamp === null ||
      typeof row.project !== "string" ||
      typeof row.id !== "string" ||
      row.id === AD_HOC_ID
    )
      continue;

    const key = taskKey(row.project, row.id);
    if (row.event === "start") {
      opened.set(key, timestamp);
      continue;
    }

    if (!terminal.has(row.event ?? "")) continue;

    const startedAt = opened.get(key);
    opened.delete(key);
    if (startedAt === undefined || startedAt < cutoff) continue;

    const candidate = index.get(key) ?? "unknown";
    const effort = efforts.some((value) => value === candidate) ? candidate : "unknown";
    tasks.push({ project: row.project, taskId: row.id, effort, startedAt, endedAt: timestamp });
  }

  return tasks;
}

function sorted(values: readonly number[]): number[] {
  return [...values].sort((left, right) => left - right);
}

function roundedStat(values: readonly number[], probability: number): number | null {
  if (!values.length) return null;

  const index = Math.max(
    0,
    Math.min(Math.ceil(probability * values.length) - 1, values.length - 1),
  );

  return round(values[index]!);
}

function summarizeTasks(tasks: Task[]) {
  const durations = sorted(tasks.map((task) => (task.endedAt - task.startedAt) / 1e6 / 60));
  const histogram = Object.fromEntries(histogramBins.map(([label]) => [label, 0]));
  for (const duration of durations) {
    const bin = histogramBins.find(([, upper]) => duration < upper);
    if (bin) histogram[bin[0]]!++;
  }

  const byEffort: { [key: string]: { n: number; median_minutes: number | null } } = {};
  for (const effort of efforts) {
    const values = sorted(
      tasks
        .filter((task) => task.effort === effort)
        .map((task) => (task.endedAt - task.startedAt) / 1e6 / 60),
    );

    byEffort[effort] = { n: values.length, median_minutes: roundedStat(values, 0.5) };
  }

  return {
    n: tasks.length,
    median_minutes: roundedStat(durations, 0.5),
    p75_minutes: roundedStat(durations, 0.75),
    histogram,
    by_effort: byEffort,
  };
}

function isHumanPrompt(event: TranscriptEvent): boolean {
  return (
    event.type === "user" &&
    !event.isMeta &&
    !blankText.test(event.text) &&
    !event.text.includes("task-notification")
  );
}

function windowsFromEvents(events: TranscriptEvent[]): Window[] {
  const windows: Window[] = [];

  let current: TranscriptEvent[] = [];
  for (const event of [...events].sort((left, right) => left.timestamp - right.timestamp))
    if (isHumanPrompt(event)) {
      if (current.length) windows.push({ prompt: current[0]!.text, events: current });
      current = [event];
    } else if (current.length) current.push(event);

  if (current.length) windows.push({ prompt: current[0]!.text, events: current });

  return windows.filter((window) => window.events.length > 3 && plansDo.test(window.prompt));
}

function isEdit(block: RecordObject): boolean {
  if (block.type !== "tool_use") return false;

  const name = toolName(block);
  if (editTools.has(name)) return true;

  const input = block.input;
  if (!object(input)) return false;

  const encoded = JSON.stringify(input);
  if (encoded.includes("workspace-write")) return true;
  if (
    !spawnTools.has(name) ||
    (typeof input.subagent_type === "string" && reviewOnlyAgents.has(input.subagent_type))
  )
    return false;

  return /[Ii]mplement/u.test(encoded);
}

function mergedSeconds(intervals: readonly Interval[]): number {
  if (!intervals.length) return 0;

  const ordered = [...intervals].sort((left, right) => left[0] - right[0] || left[1] - right[1]);

  let [currentStart, currentEnd] = ordered[0]!;
  let total = 0;
  for (const [start, end] of ordered.slice(1))
    if (start > currentEnd) {
      total += (currentEnd - currentStart) / 1e6;
      currentStart = start;
      currentEnd = end;
    } else currentEnd = Math.max(currentEnd, end);

  return total + (currentEnd - currentStart) / 1e6;
}

function windowMetrics(window: Window): Metrics {
  const events = window.events;
  const start = events[0]!.timestamp;
  const end = events.at(-1)!.timestamp;

  let modelSeconds = 0;
  let subagentWaitSeconds = 0;

  const codexWaitIntervals: Interval[] = [];
  const toolIntervals = new Map<string, Interval[]>();
  const toolStarts = new Map<string, readonly [string, number]>();

  const codexArmIds = new Set<string>();
  const codexBackgroundIds = new Set<string>();
  const taskOutputStarts = new Map<string, readonly [string, number]>();

  let firstEdit: number | null = null;
  let lastEdit: number | null = null;
  let lastToolResult: number | null = null;
  for (const [index, event] of events.entries()) {
    if (index) {
      const previous = events[index - 1]!.timestamp;
      const gap = (event.timestamp - previous) / 1e6;
      if (event.type === "user" && event.text.includes("task-notification") && gap > 0) {
        const task = notifiedTask.exec(event.text);
        const toolUse = notifiedToolUse.exec(event.text);
        if (
          (task !== null && codexBackgroundIds.has(task[1]!)) ||
          (toolUse !== null && codexArmIds.has(toolUse[1]!))
        )
          codexWaitIntervals.push([previous, event.timestamp]);
        else subagentWaitSeconds += gap;
      }
    }

    if (event.type === "assistant" && lastToolResult !== null) {
      const gap = (event.timestamp - lastToolResult) / 1e6;
      if (gap > 0 && gap < 1800) modelSeconds += gap;
      lastToolResult = null;
    }

    for (const block of event.blocks) {
      if (isEdit(block)) {
        if (firstEdit === null) firstEdit = event.timestamp;
        lastEdit = event.timestamp;
      }

      if (block.type === "tool_use" && typeof block.id === "string") {
        const name = toolName(block);
        toolStarts.set(block.id, [name, event.timestamp]);

        const input = block.input;
        if (
          name === "Bash" &&
          object(input) &&
          typeof input.command === "string" &&
          codexArm.test(input.command)
        )
          codexArmIds.add(block.id);

        if (
          name === "TaskOutput" &&
          object(input) &&
          typeof input.task_id === "string" &&
          codexBackgroundIds.has(input.task_id)
        )
          taskOutputStarts.set(block.id, [input.task_id, event.timestamp]);
      }

      if (block.type !== "tool_result") continue;

      const id = block.tool_use_id;
      if (typeof id === "string") {
        if (codexArmIds.has(id)) {
          const background = backgroundTask.exec(extractedText(block.content));
          if (background !== null) codexBackgroundIds.add(background[1]!);
        }

        const taskOutputStart = taskOutputStarts.get(id);
        taskOutputStarts.delete(id);

        if (taskOutputStart !== undefined && event.timestamp > taskOutputStart[1])
          codexWaitIntervals.push([taskOutputStart[1], event.timestamp]);

        const toolStart = toolStarts.get(id);
        toolStarts.delete(id);

        if (toolStart !== undefined && event.timestamp > toolStart[1]) {
          const intervals = toolIntervals.get(toolStart[0]) ?? [];
          intervals.push([toolStart[1], event.timestamp]);
          toolIntervals.set(toolStart[0], intervals);
        }
      }

      lastToolResult = event.timestamp;
    }
  }

  return {
    duration_s: Math.max(0, (end - start) / 1e6),
    to_first_edit_s: firstEdit === null ? null : (firstEdit - start) / 1e6,
    tail_s: lastEdit === null ? null : (end - lastEdit) / 1e6,
    model_s: modelSeconds,
    bash_s: mergedSeconds(toolIntervals.get("Bash") ?? []),
    question_s: mergedSeconds(toolIntervals.get("AskUserQuestion") ?? []),
    subagent_wait_s: subagentWaitSeconds,
    codex_wait_s: mergedSeconds(codexWaitIntervals),
  };
}

function compareText(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index++) {
    const difference = leftPoints[index]!.codePointAt(0)! - rightPoints[index]!.codePointAt(0)!;
    if (difference) return difference;
  }

  return leftPoints.length - rightPoints.length;
}

function addGroup(groups: Map<string, number[]>, key: readonly string[], value: number): void {
  const encoded = JSON.stringify(key);
  const values = groups.get(encoded) ?? [];
  values.push(value);
  groups.set(encoded, values);
}

function modelOrder(
  left: { n: number; model: string; effort: string },
  right: { n: number; model: string; effort: string },
): number {
  return (
    right.n - left.n ||
    compareText(left.model, right.model) ||
    compareText(left.effort, right.effort)
  );
}

function summarizeWindows(windows: Window[], subagents: Subagent[]) {
  const metrics = windows.map(windowMetrics);
  const kept = metrics.filter(
    (metric) => metric.duration_s / 60 >= 5 && metric.duration_s / 60 <= 120,
  );

  const durations = sorted(kept.map((metric) => metric.duration_s / 60));
  const firstEdits = sorted(
    kept.flatMap((metric) => (metric.to_first_edit_s === null ? [] : [metric.to_first_edit_s])),
  );

  const tails = sorted(kept.flatMap((metric) => (metric.tail_s === null ? [] : [metric.tail_s])));
  const totalDuration = sum(kept.map((metric) => metric.duration_s));

  const walls: number[] = [];
  const byType = new Map<string, number[]>();
  const byModelEffort = new Map<string, number[]>();
  for (const subagent of subagents) {
    const wall = Math.max(0, (subagent.endedAt - subagent.startedAt) / 1e6);
    walls.push(wall);
    addGroup(byType, [subagent.agentType], wall / 60);
    addGroup(byModelEffort, [subagent.model, subagent.effort], wall / 60);
  }

  const typeBreakdown = [...byType]
    .map(([key, values]) => ({
      agent_type: (JSON.parse(key) as string[])[0]!,
      n: values.length,
      median_wall_minutes: roundedStat(sorted(values), 0.5),
    }))
    .sort((left, right) => right.n - left.n || compareText(left.agent_type, right.agent_type));

  const modelEffortBreakdown = [...byModelEffort]
    .map(([key, values]) => {
      const [model, effort] = JSON.parse(key) as [string, string];
      return { model, effort, n: values.length, total_wall_minutes: round(sum(values)) };
    })
    .sort(modelOrder);

  const pooledShare = (
    field: "model_s" | "bash_s" | "subagent_wait_s" | "codex_wait_s" | "question_s",
  ): number =>
    totalDuration ? round((100 * sum(kept.map((metric) => metric[field]))) / totalDuration) : 0;

  return {
    found: windows.length,
    kept: kept.length,
    median_duration_minutes: roundedStat(durations, 0.5),
    p75_duration_minutes: roundedStat(durations, 0.75),
    median_to_first_edit_seconds: roundedStat(firstEdits, 0.5),
    median_tail_seconds: roundedStat(tails, 0.5),
    p75_tail_seconds: roundedStat(tails, 0.75),
    no_edit: sum(kept.map((metric) => (metric.to_first_edit_s === null ? 1 : 0))),
    shares_percent: {
      model_round_trips: pooledShare("model_s"),
      bash: pooledShare("bash_s"),
      subagent_wait: pooledShare("subagent_wait_s"),
      codex_wait: pooledShare("codex_wait_s"),
      questions: pooledShare("question_s"),
    },
    subagents: {
      n: subagents.length,
      total_wall_hours: round(sum(walls) / 3600),
      by_agent_type: typeBreakdown,
      by_model_effort: modelEffortBreakdown,
    },
  };
}

function wallSummary(values: number[]) {
  const ordered = sorted(values);
  return {
    n: values.length,
    median_wall_minutes: roundedStat(ordered, 0.5),
    p75_wall_minutes: roundedStat(ordered, 0.75),
  };
}

function summarizeCodexRuns(runs: CodexRun[], notes: Notes) {
  const groups = new Map<string, number[]>();
  const byOriginator = new Map<string, number[]>();

  let resumed = 0;
  for (const run of runs) {
    const wallMinutes = Math.max(0, (run.endedAt - run.startedAt) / 1e6 / 60);
    if (wallMinutes > 720) {
      resumed++;
      continue;
    }

    addGroup(groups, [run.model, run.effort], wallMinutes);
    addGroup(byOriginator, [run.originator, run.model, run.effort], wallMinutes);
  }

  if (resumed)
    note(notes, `${resumed} rollout(s) spanning over 12h treated as resumed and excluded`);

  const summaryGroups = [...groups]
    .map(([key, values]) => {
      const [model, effort] = JSON.parse(key) as [string, string];
      return { model, effort, ...wallSummary(values) };
    })
    .sort(modelOrder);

  const originatorGroups = [...byOriginator]
    .map(([key, values]) => {
      const [originator, model, effort] = JSON.parse(key) as [string, string, string];
      return { originator, model, effort, ...wallSummary(values) };
    })
    .sort(
      (left, right) =>
        right.n - left.n ||
        compareText(left.originator, right.originator) ||
        compareText(left.model, right.model) ||
        compareText(left.effort, right.effort),
    );

  return {
    n: runs.length,
    resumed_excluded: resumed,
    groups: summaryGroups,
    by_originator: originatorGroups,
  };
}

function textTable(
  headers: readonly string[],
  rows: readonly (readonly Cell[])[],
  floats: readonly number[] = [],
): string {
  const rendered = rows.map((row) =>
    row.map((value, index) =>
      value === null
        ? "n/a"
        : typeof value === "number" && floats.includes(index)
          ? fixed(value)
          : String(value),
    ),
  );

  const widths = headers.map((header, index) =>
    Math.max([...header].length, ...rendered.map((row) => [...row[index]!].length)),
  );

  const pad = (row: readonly string[]): string =>
    row.map((value, index) => value + " ".repeat(widths[index]! - [...value].length)).join("  ");

  return [pad(headers), ...rendered.map(pad)].join("\n");
}

export type Result = {
  days: number;
  generated_at: string;
  tasks: ReturnType<typeof summarizeTasks> & { notes: Notes };
  windows: ReturnType<typeof summarizeWindows> & { notes: Notes };
  codex: ReturnType<typeof summarizeCodexRuns> & { notes: Notes };
  follow_up_fixes?: { rows: FollowUpRow[]; notes: Notes };
};

function render(result: Result): string {
  const { tasks, windows, codex } = result;
  const subagents = windows.subagents;
  const parts = [
    `Session audit, last ${result.days} days through ${result.generated_at}`,
    "Task durations from the plans trail",
    textTable(
      ["n", "median minutes", "p75 minutes"],
      [[tasks.n, tasks.median_minutes, tasks.p75_minutes]],
      [1, 2],
    ),
    "Histogram",
    textTable(["duration bin", "n"], Object.entries(tasks.histogram)),
    "By effort",
    textTable(
      ["effort", "n", "median minutes"],
      Object.entries(tasks.by_effort).map(([effort, values]) => [
        effort,
        values.n,
        values.median_minutes,
      ]),
      [2],
    ),
    ...tasks.notes.map((message) => `Note: ${message}`),
    "Phase split of /plans do windows",
    textTable(
      [
        "found",
        "kept",
        "median duration minutes",
        "p75 duration minutes",
        "median first edit seconds",
        "median tail seconds",
        "p75 tail seconds",
        "no edit",
      ],
      [
        [
          windows.found,
          windows.kept,
          windows.median_duration_minutes,
          windows.p75_duration_minutes,
          windows.median_to_first_edit_seconds,
          windows.median_tail_seconds,
          windows.p75_tail_seconds,
          windows.no_edit,
        ],
      ],
      [2, 3, 4, 5, 6],
    ),
    "Pooled shares of summed duration",
    textTable(
      ["phase", "percent"],
      [
        ["model round trips", windows.shares_percent.model_round_trips],
        ["Bash", windows.shares_percent.bash],
        ["waiting on subagents", windows.shares_percent.subagent_wait],
        ["waiting on Codex arms", windows.shares_percent.codex_wait],
        ["questions", windows.shares_percent.questions],
      ],
      [1],
    ),
    "Subagents",
    textTable(["n", "total wall hours"], [[subagents.n, subagents.total_wall_hours]], [1]),
    textTable(
      ["agent type", "n", "median wall minutes"],
      subagents.by_agent_type.map((row) => [row.agent_type, row.n, row.median_wall_minutes]),
      [2],
    ),
    textTable(
      ["model", "effort", "n", "total wall minutes"],
      subagents.by_model_effort.map((row) => [
        row.model,
        row.effort,
        row.n,
        row.total_wall_minutes,
      ]),
      [3],
    ),
    ...windows.notes.map((message) => `Note: ${message}`),
    "Codex runs grouped by model and effort",
    textTable(["overall n"], [[codex.n]]),
    textTable(
      ["model", "effort", "n", "median wall minutes", "p75 wall minutes"],
      codex.groups.map((row) => [
        row.model,
        row.effort,
        row.n,
        row.median_wall_minutes,
        row.p75_wall_minutes,
      ]),
      [3, 4],
    ),
    "Codex runs grouped by originator, model and effort",
    textTable(
      ["originator", "model", "effort", "n", "median wall minutes", "p75 wall minutes"],
      codex.by_originator.map((row) => [
        row.originator,
        row.model,
        row.effort,
        row.n,
        row.median_wall_minutes,
        row.p75_wall_minutes,
      ]),
      [4, 5],
    ),
    ...codex.notes.map((message) => `Note: ${message}`),
    "Follow-up fixes by implementer",
    ...(result.follow_up_fixes === undefined
      ? ["Pass --prs to read merged PRs from GitHub."]
      : [
          textTable(
            ["implementer", "merged", "followed up", "share"],
            result.follow_up_fixes.rows.map((row) => [
              row.implementer,
              row.merged,
              row.followed_up,
              row.share,
            ]),
            [3],
          ),
          ...result.follow_up_fixes.notes.map((message) => `Note: ${message}`),
        ]),
  ];

  return parts.join("\n\n");
}

function usage(): string {
  return "usage: skills audit [-h] [--days DAYS] [--json] [--prs] [--project-dir PROJECT_DIR] [--compare OLD [NEW] | --digest]\n";
}

function argumentError(message: string): Output {
  return { code: 2, stdout: "", stderr: `${usage()}skills audit: error: ${message}\n` };
}

function parseArguments(args: readonly string[]): Arguments | Output {
  try {
    const { values, tokens } = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      tokens: true,
      options: {
        help: { type: "boolean", short: "h" },
        days: { type: "string" },
        json: { type: "boolean" },
        prs: { type: "boolean" },
        "project-dir": { type: "string" },
        compare: { type: "string" },
        digest: { type: "boolean" },
      },
    });

    if (tokens.some((token) => token.kind === "option-terminator"))
      return argumentError("unrecognized argument: --");

    if (values.help)
      return {
        code: 0,
        stdout: `${usage()}\nReport task timing from local session stores.\n\noptions:\n  -h, --help            show this help message and exit\n  --days DAYS\n  --json\n  --prs                 read merged PRs from GitHub\n  --project-dir PROJECT_DIR\n  --compare OLD [NEW]   compare OLD audit JSON with NEW, or with this run\n  --digest              save this run under <plans>/audit and compare it with the last saved run\n`,
        stderr: "",
      };

    const positionals = tokens.filter((token) => token.kind === "positional");
    if (positionals.length > (values.compare === undefined ? 0 : 1))
      return argumentError(
        `unrecognized arguments: ${positionals.map((token) => token.value).join(" ")}`,
      );

    if (values.digest && (values.compare !== undefined || values.json))
      return argumentError("argument --digest: not allowed with --compare or --json");

    if (values.compare !== undefined && values.json)
      return argumentError("argument --compare: not allowed with --json");

    const days = values.days ?? "14";
    if (!/^\d+$/u.test(days)) return argumentError(`argument --days: invalid int value: '${days}'`);

    return {
      days: Number(days),
      json: values.json ?? false,
      prs: values.prs ?? false,
      projectDir: values["project-dir"],
      compare:
        values.compare === undefined
          ? undefined
          : { old: values.compare, current: positionals[0]?.value },
      digest: values.digest ?? false,
    };
  } catch (error) {
    return argumentError(error instanceof Error ? error.message : String(error));
  }
}

const savedRun = /^\d{4}-\d{2}-\d{2}\.json$/u;

function failure(message: string): Output {
  return { code: 1, stdout: "", stderr: `skills audit: ${message}\n` };
}

function readRun(path: string): RecordObject | string {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `cannot read ${path}: ${reason}`;
  }

  return object(value) ? value : `${path} is not an audit JSON object`;
}

function asRun(result: Result): RecordObject {
  return JSON.parse(JSON.stringify(result)) as RecordObject;
}

function digest(result: Result, repository: string, env: NodeJS.ProcessEnv): Output {
  const directory = `${plansDir(env)}/audit/${repository}`;
  const name = `${result.generated_at.slice(0, 10)}.json`;
  const path = `${directory}/${name}`;
  const temporary = `${path}.${process.pid}.tmp`;

  let previous: string | undefined;
  let written = false;
  try {
    mkdirSync(directory, { recursive: true });
    previous = directoryEntries(directory)
      .filter((entry) => savedRun.test(entry) && entry < name)
      .sort()
      .at(-1);

    writeFileSync(temporary, `${JSON.stringify(result)}\n`, { flag: "wx" });
    written = true;
    renameSync(temporary, path);
  } catch (error) {
    if (written) rmSync(temporary, { force: true });

    return failure(
      `cannot save the digest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (previous === undefined)
    return {
      code: 0,
      stdout: `Saved ${path}\nNothing to compare: no saved run before ${name} in ${directory}\n`,
      stderr: "",
    };

  const old = readRun(`${directory}/${previous}`);
  if (typeof old === "string") return failure(old);

  return {
    code: 0,
    stdout: `Saved ${path}\nCompared with ${directory}/${previous}\n${compareRuns(old, asRun(result))}\n`,
    stderr: "",
  };
}

export async function audit(args: readonly string[], options: Options): Promise<Output> {
  const parsed = parseArguments(args);
  if ("code" in parsed) return parsed;

  if (parsed.compare?.current !== undefined) {
    const old = readRun(parsed.compare.old);
    if (typeof old === "string") return failure(old);

    const current = readRun(parsed.compare.current);
    if (typeof current === "string") return failure(current);

    return { code: 0, stdout: `${compareRuns(old, current)}\n`, stderr: "" };
  }

  const old = parsed.compare === undefined ? undefined : readRun(parsed.compare.old);
  if (typeof old === "string") return failure(old);

  const result = await runAudit(parsed, options);
  if ("code" in result) return result;

  if (old !== undefined)
    return { code: 0, stdout: `${compareRuns(old, asRun(result))}\n`, stderr: "" };

  if (parsed.digest) {
    const repository = basename(
      parsed.projectDir ?? checkoutRoots(options.cwd, options.env.HOME ?? "", options.env)[0]!,
    );

    if (repository === "" || repository === "." || repository === "..")
      return failure("--digest cannot name the repository it audits");

    return digest(result, repository, options.env);
  }

  const text = parsed.json
    ? JSON.stringify(result)
    : options.terminal
      ? prettyReport(result, {
          color: colorEnabled(options.env),
          home: options.env.HOME ?? "",
          width: options.terminal.width,
        })
      : render(result);

  return {
    code: 0,
    stdout: `${text}\n`,
    stderr: "",
  };
}

async function runAudit(parsed: Arguments, options: Options): Promise<Result | Output> {
  const home = options.env.HOME ?? "";
  const nowMicros = options.now.getTime() * 1000;
  const cutoff = nowMicros - parsed.days * 86400e6;
  if (!(cutoff >= earliestMicros)) return failure("--days reaches before year 1");

  const taskNotes: Notes = [];
  const windowNotes: Notes = [];
  const codexNotes: Notes = [];

  const tasks = readTasks(plansDir(options.env), cutoff, taskNotes);
  const store: SessionStore =
    parsed.projectDir === undefined
      ? repositoryStore(home, options.cwd, options.env, windowNotes)
      : { folders: [parsed.projectDir], keeps: null };

  const windows: Window[] = [];
  const transcripts = [
    ...readTranscripts(store, parsed.prs ? cutoff - 30 * 86400e6 : cutoff, windowNotes),
  ];

  for (const events of transcripts)
    windows.push(
      ...windowsFromEvents(events).filter((window) => window.events[0]!.timestamp >= cutoff),
    );

  const subagents = readSubagents(store, cutoff, windowNotes);
  const runs = readCodexRuns(home, cutoff, codexNotes);
  const result: Result = {
    days: parsed.days,
    generated_at: options.now.toISOString().slice(0, 19) + "Z",
    tasks: { ...summarizeTasks(tasks), notes: taskNotes },
    windows: { ...summarizeWindows(windows, subagents), notes: windowNotes },
    codex: { ...summarizeCodexRuns(runs, codexNotes), notes: codexNotes },
  };

  if (parsed.prs) {
    const notes: Notes = [];
    const gh =
      options.gh ??
      ((args: readonly string[]) =>
        ghOutput(args, { ...processIo(), cwd: options.cwd, env: options.env, err: () => {} }));

    const git =
      options.git ??
      (async (args: readonly string[]) => {
        const result = await read(["git", ...args], {
          cwd: options.cwd,
          env: options.env,
          deadline: 30_000,
        });

        return result.ok && result.code === 0 ? result.stdout : undefined;
      });

    result.follow_up_fixes = await followUps({ gh, git, cutoff, transcripts, notes });
  }

  return result;
}

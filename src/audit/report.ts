import { painter, tilde, wrap } from "../terminal.ts";
import type { Result } from "./audit.ts";

export type PrettyOptions = { color: boolean; home: string; width: number };

type Paint = ReturnType<typeof painter>;
type Align = "left" | "right";

const binLabels: { [bin: string]: string } = {
  "<10m": "under 10m",
  "10-20m": "10m to 20m",
  "20-30m": "20m to 30m",
  "30-45m": "30m to 45m",
  "45-60m": "45m to 1h",
  "60-120m": "1h to 2h",
  ">120m": "over 2h",
};

const eighths = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

export function duration(minutes: number | null): string {
  if (minutes === null) return "none";

  const seconds = Math.round(Math.abs(minutes) * 60);
  const sign = minutes < 0 && seconds > 0 ? "-" : "";
  if (seconds < 60) return `${sign}${seconds}s`;

  const whole = Math.round(seconds / 60);
  if (whole < 60) return `${sign}${whole}m`;

  const rest = whole % 60;
  return `${sign}${Math.floor(whole / 60)}h${rest ? ` ${rest}m` : ""}`;
}

export function count(value: number): string {
  return value.toLocaleString("en-US");
}

export function bar(value: number, peak: number, width = 24): string {
  if (value <= 0 || peak <= 0) return "";
  const steps = Math.max(1, Math.round((Math.min(value, peak) / peak) * width * 8));
  return "█".repeat(Math.floor(steps / 8)) + eighths[steps % 8];
}

function length(text: string): number {
  return [...text].length;
}

function padded(text: string, width: number, align: Align): string {
  const fill = " ".repeat(Math.max(0, width - length(text)));
  return align === "right" ? fill + text : text + fill;
}

function table(
  paint: Paint,
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  align: readonly Align[],
): string[] {
  const widths = headers.map((header, index) =>
    Math.max(length(header), ...rows.map((row) => length(row[index]!))),
  );

  const line = (cells: readonly string[]) =>
    `  ${cells.map((cell, index) => padded(cell, widths[index]!, align[index]!)).join("  ")}`.trimEnd();

  return [paint.dim(line(headers)), ...rows.map(line)];
}

function bars(
  paint: Paint,
  rows: readonly (readonly [string, number, string])[],
  peak: number,
): string[] {
  const labelWidth = Math.max(...rows.map(([label]) => length(label)));
  const valueWidth = Math.max(...rows.map(([, , value]) => length(value)));

  return rows.map(([label, amount, value]) => {
    const text = `  ${padded(label, labelWidth, "left")}  ${padded(value, valueWidth, "right")}`;
    return amount > 0 ? `${text}  ${paint.cyan(bar(amount, peak))}` : paint.dim(text);
  });
}

export function prettyReport(result: Result, options: PrettyOptions): string {
  const paint = painter(options.color);
  const shorten = tilde(options.home);
  const dot = paint.dim(" · ");
  const { tasks, windows, codex } = result;
  const subagents = windows.subagents;

  const sections: string[][] = [
    [paint.bold(`Session audit, last ${result.days} days through ${result.generated_at}`)],
  ];

  const section = (title: string, ...lines: string[]) =>
    sections.push([paint.bold(title), ...lines]);

  const empty = (title: string, reason: string) =>
    sections.push([paint.dim(`${title}: ${reason}`)]);

  const summary = (...parts: string[]) => `  ${parts.join(dot)}`;
  const notes = (messages: readonly string[]) => {
    const width = Math.max(options.width, 40) - 5;
    const lines = messages.flatMap((message) =>
      wrap(`Note: ${shorten(message)}`, width).map((line, index) =>
        paint.dim(`${index ? "    " : "  "}${line}`),
      ),
    );

    sections.at(-1)!.push(...lines);
  };

  const title = "Task durations from the plans trail";
  if (!tasks.n) empty(title, "no finished tasks");
  else {
    const histogram = Object.entries(tasks.histogram);
    const efforts = Object.entries(tasks.by_effort).filter(([, values]) => values.n);
    section(
      title,
      summary(
        `${count(tasks.n)} tasks`,
        `median ${duration(tasks.median_minutes)}`,
        `p75 ${duration(tasks.p75_minutes)}`,
      ),
      "",
      ...bars(
        paint,
        histogram.map(([bin, n]) => [binLabels[bin] ?? bin, n, count(n)]),
        Math.max(...histogram.map(([, n]) => n)),
      ),
      "",
      ...table(
        paint,
        ["effort", "tasks", "median"],
        efforts.map(([effort, values]) => [
          effort,
          count(values.n),
          duration(values.median_minutes),
        ]),
        ["left", "right", "right"],
      ),
    );
  }

  notes(tasks.notes);

  const phases = "Phase split of /plans do windows";
  const shares = "Pooled shares of summed duration";
  if (!windows.found) empty(phases, "none found");
  else if (!windows.kept) {
    section(phases, summary(`${count(windows.found)} found`, "none lasted between 5m and 2h"));
    empty(shares, "no windows kept");
  } else {
    const seconds = (value: number | null) => duration(value === null ? null : value / 60);
    section(
      phases,
      summary(
        `${count(windows.found)} found`,
        `${count(windows.kept)} kept (5m to 2h)`,
        ...(windows.no_edit ? [`${count(windows.no_edit)} with no edit`] : []),
      ),
      "",
      ...table(
        paint,
        ["", "median", "p75"],
        [
          [
            "duration",
            duration(windows.median_duration_minutes),
            duration(windows.p75_duration_minutes),
          ],
          ["to first edit", seconds(windows.median_to_first_edit_seconds), ""],
          [
            "tail after last edit",
            seconds(windows.median_tail_seconds),
            seconds(windows.p75_tail_seconds),
          ],
        ],
        ["left", "right", "right"],
      ),
    );

    const share = windows.shares_percent;
    section(
      shares,
      ...bars(
        paint,
        (
          [
            ["model round trips", share.model_round_trips],
            ["Bash", share.bash],
            ["waiting on subagents", share.subagent_wait],
            ["waiting on Codex arms", share.codex_wait],
            ["questions", share.questions],
          ] as const
        ).map(([label, value]) => [label, value, `${value.toFixed(1)}%`]),
        100,
      ),
    );
  }

  if (!subagents.n) empty("Subagents", "none");
  else
    section(
      "Subagents",
      summary(
        `${count(subagents.n)} runs`,
        `${duration(subagents.total_wall_hours * 60)} of wall time`,
      ),
      "",
      ...table(
        paint,
        ["agent type", "runs", "median"],
        subagents.by_agent_type.map((row) => [
          row.agent_type,
          count(row.n),
          duration(row.median_wall_minutes),
        ]),
        ["left", "right", "right"],
      ),
      "",
      ...table(
        paint,
        ["model", "effort", "runs", "total"],
        subagents.by_model_effort.map((row) => [
          row.model,
          row.effort,
          count(row.n),
          duration(row.total_wall_minutes),
        ]),
        ["left", "left", "right", "right"],
      ),
    );

  notes(windows.notes);

  if (!codex.n) empty("Codex runs", "none");
  else {
    section(
      "Codex runs grouped by model and effort",
      summary(`${count(codex.n)} runs`),
      "",
      ...table(
        paint,
        ["model", "effort", "runs", "median", "p75"],
        codex.groups.map((row) => [
          row.model,
          row.effort,
          count(row.n),
          duration(row.median_wall_minutes),
          duration(row.p75_wall_minutes),
        ]),
        ["left", "left", "right", "right", "right"],
      ),
    );

    section(
      "Codex runs grouped by originator, model and effort",
      ...table(
        paint,
        ["originator", "model", "effort", "runs", "median", "p75"],
        codex.by_originator.map((row) => [
          row.originator,
          row.model,
          row.effort,
          count(row.n),
          duration(row.median_wall_minutes),
          duration(row.p75_wall_minutes),
        ]),
        ["left", "left", "left", "right", "right", "right"],
      ),
    );
  }

  notes(codex.notes);

  return sections.map((lines) => lines.join("\n")).join("\n\n");
}

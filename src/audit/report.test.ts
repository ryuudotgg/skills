import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Result } from "./audit.ts";
import { bar, count, duration, prettyReport } from "./report.ts";

async function fixture(): Promise<Result> {
  const result = JSON.parse(await readFile(join(import.meta.dir, "expected.json"), "utf8"));
  result.windows.notes = ["/home/me/.claude/projects/broken.jsonl is unavailable"];
  return result;
}

describe("number formats", () => {
  test("durations read as hours, minutes or seconds", () => {
    const cases: readonly (readonly [number | null, string])[] = [
      [95.58, "1h 36m"],
      [12, "12m"],
      [120, "2h"],
      [59.995, "1h"],
      [0.34, "20s"],
      [0.995, "1m"],
      [0, "0s"],
      [-6.67, "-7m"],
      [-0.001, "0s"],
      [1830, "30h 30m"],
      [null, "none"],
    ];

    for (const [minutes, text] of cases) expect(duration(minutes)).toBe(text);
  });

  test("counts group thousands", () => {
    expect(count(915)).toBe("915");
    expect(count(12345)).toBe("12,345");
  });

  test("bars scale to the peak in eighths and never vanish for a nonzero value", () => {
    const cases: readonly (readonly [number, number, string])[] = [
      [70, 70, "█".repeat(24)],
      [35, 70, "█".repeat(12)],
      [4, 70, "█▍"],
      [0.01, 100, "▏"],
      [0, 70, ""],
      [5, 0, ""],
    ];

    for (const [value, peak, text] of cases) expect(bar(value, peak)).toBe(text);
  });
});

describe("pretty report", () => {
  test("the fixture renders to the golden", async () => {
    const text = prettyReport(await fixture(), { color: false, home: "/home/me", width: 100 });
    expect(`${text}\n`).toBe(await readFile(join(import.meta.dir, "expected-pretty.txt"), "utf8"));
  });

  test("color bolds headers and dims muted lines without changing the text", async () => {
    const result = await fixture();
    const plain = prettyReport(result, { color: false, home: "/home/me", width: 100 });
    const colored = prettyReport(result, { color: true, home: "/home/me", width: 100 });

    expect(colored).toStartWith("\u001b[1mSession audit, last 14 days through ");
    expect(colored).toContain("\u001b[1mSubagents\u001b[22m");
    expect(colored).toContain("\u001b[2m  20m to 30m  0\u001b[22m");
    expect(stripVTControlCharacters(colored)).toBe(plain);
  });

  test("sections without data collapse to one line each", async () => {
    const base = await fixture();
    const result: Result = {
      ...base,
      tasks: { ...base.tasks, n: 0 },
      windows: {
        ...base.windows,
        found: 0,
        notes: [],
        subagents: { ...base.windows.subagents, n: 0 },
      },
      codex: { ...base.codex, n: 0, resumed_excluded: 0, notes: [] },
    };

    expect(prettyReport(result, { color: false, home: "", width: 100 })).toBe(
      [
        "Session audit, last 14 days through 2026-09-20T12:00:00Z",
        "Task durations from the plans trail: no finished tasks",
        "Phase split of /plans do windows: none found",
        "Subagents: none",
        "Codex runs: none",
      ].join("\n\n"),
    );
  });

  test("windows that were all dropped keep the count and skip the shares", async () => {
    const result = await fixture();
    result.windows.kept = 0;

    const text = prettyReport(result, { color: false, home: "", width: 100 });
    expect(text).toContain(
      "Phase split of /plans do windows\n  4 found · none lasted between 5m and 2h\n\nPooled shares of summed duration: no windows kept",
    );
  });

  test("the Codex count leaves out resumed runs, as its tables do", async () => {
    const result = await fixture();
    const text = prettyReport(result, { color: false, home: "", width: 100 });
    expect(text).toContain("Codex runs grouped by model and effort\n  3 runs\n");

    const resumed = prettyReport(
      {
        ...result,
        codex: { ...result.codex, n: 2, resumed_excluded: 2, groups: [], by_originator: [] },
      },
      { color: false, home: "", width: 100 },
    );

    expect(resumed).toContain("Codex runs: none\n  Note: 1 rollout(s) changed");
  });

  test("long notes wrap under a hanging indent", async () => {
    const result = await fixture();
    result.codex.notes = ["one two three four five six seven eight nine ten eleven twelve"];

    const text = prettyReport(result, { color: false, home: "", width: 40 });
    expect(text).toEndWith(
      "  Note: one two three four five six\n    seven eight nine ten eleven twelve",
    );
  });
});

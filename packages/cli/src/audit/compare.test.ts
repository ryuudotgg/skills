import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { removeTemporary } from "../test/process.ts";
import { audit } from "./audit.ts";
import { compareRuns } from "./compare.ts";

const fixture = join(import.meta.dir, "compare-fixture");
const oldPath = join(fixture, "old.json");
const tailUpPath = join(fixture, "tail-up.json");

async function load(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

function flagged(text: string): string[] {
  return text.split("\n").filter((line) => line.startsWith("flag"));
}

describe("compareRuns", () => {
  test("only the 30% tail rise is flagged", async () => {
    const text = compareRuns(await load(oldPath), await load(tailUpPath));

    expect(flagged(text)).toEqual(["flag  windows.median_tail_seconds  280.00 to 364.00, +30.00%"]);
    expect(text).toEndWith("\n1 flagged");
    expect(text).toContain("ok    codex.xhigh_runs  4 to 4, +0.00%");
    expect(text).toContain("ok    follow_up_fixes.claude.share_percent  20.00 to 20.00, +0.00 pp");
    expect(text).not.toContain("tasks.by_effort.L.median_minutes");
  });

  test("times and counts flag at 25% relative, shares at 5 points", async () => {
    const old = await load(oldPath);
    const current = await load(oldPath);

    current.tasks.median_minutes = 50;
    current.tasks.by_effort.S.median_minutes = 37.4;

    current.windows.shares_percent.bash = 5.15;
    current.windows.shares_percent.questions = 6.8;
    current.codex.groups.push({ model: "gpt-6.1-sol", effort: "xhigh", n: 1 });
    current.follow_up_fixes.rows[1].share = 0.15;

    expect(flagged(compareRuns(old, current))).toEqual([
      "flag  tasks.median_minutes  40.00 to 50.00, +25.00%",
      "flag  windows.shares_percent.bash  0.15 to 5.15, +5.00 pp",
      "flag  codex.xhigh_runs  4 to 5, +25.00%",
      "flag  follow_up_fixes.codex.share_percent  10.00 to 15.00, +5.00 pp",
    ]);
  });

  test("the newer run's notes follow the count", async () => {
    const old = await load(oldPath);
    const current = await load(tailUpPath);

    old.follow_up_fixes.notes = ["old note"];
    current.follow_up_fixes.notes = ["gh pr list failed"];
    current.windows.notes = ["<store>/claude/broken.jsonl is unavailable"];

    expect(compareRuns(old, current).split("\n").slice(-3)).toEqual([
      "1 flagged",
      "Note: <store>/claude/broken.jsonl is unavailable",
      "Note: gh pr list failed",
    ]);
  });

  test("a field zero in both runs reads ok", async () => {
    const old = await load(oldPath);
    const current = await load(oldPath);

    old.codex.groups = [];
    current.codex.groups = [];

    expect(compareRuns(old, current)).toContain("\nok    codex.xhigh_runs  0 to 0\n");
  });

  test("a drop is never flagged", async () => {
    const old = await load(tailUpPath);
    const current = await load(oldPath);
    expect(flagged(compareRuns(old, current))).toEqual([]);
  });

  test("a field missing or zero in the old run prints as new", async () => {
    const old = await load(oldPath);
    const current = await load(oldPath);

    old.windows.shares_percent.bash = 0;
    old.codex.groups = [];
    delete old.follow_up_fixes;

    delete current.windows.median_tail_seconds;
    current.tasks.by_effort.L.median_minutes = 90;

    const lines = compareRuns(old, current).split("\n");

    expect(lines.filter((line) => /^(flag|new|gone)/u.test(line))).toEqual([
      "new   tasks.by_effort.L.median_minutes  none to 90.00",
      "gone  windows.median_tail_seconds  280.00 to none",
      "new   windows.shares_percent.bash  0.00 to 0.15",
      "new   codex.xhigh_runs  0 to 4",
      "new   follow_up_fixes.claude.share_percent  none to 20.00",
      "new   follow_up_fixes.codex.share_percent  none to 10.00",
    ]);
  });
});

describe("skills audit --compare and --digest", () => {
  let store: string;

  beforeEach(async () => {
    store = await mkdtemp(join(tmpdir(), "skills-audit-compare-"));
  });

  afterEach(async () => {
    await removeTemporary(store);
  });

  function options(now: string) {
    return {
      env: { HOME: join(store, "home"), PLANS_DIR: join(store, "plans") },
      now: new Date(now),
      cwd: store,
    };
  }

  test("two files compare without reading any session", async () => {
    const result = await audit(["--compare", oldPath, tailUpPath], options("2026-10-26T09:00:00Z"));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${compareRuns(await load(oldPath), await load(tailUpPath))}\n`);
  });

  test("an unreadable file exits 1 naming it", async () => {
    const missing = join(store, "missing.json");
    const result = await audit(["--compare", missing, tailUpPath], options("2026-10-26T09:00:00Z"));

    expect(result.code).toBe(1);
    expect(result.stderr).toStartWith(`skills audit: cannot read ${missing}: `);
  });

  test("a digest that cannot save exits 1 with a message", async () => {
    await writeFile(join(store, "plans"), "not a directory\n");

    const result = await audit(["--digest"], options("2026-10-26T09:00:00Z"));

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toStartWith("skills audit: cannot save the digest: ");
  });

  test("each repository keeps its own saved runs", async () => {
    const first = await audit(
      ["--digest", "--project-dir", join(store, "one")],
      options("2026-10-19T09:00:00Z"),
    );

    const second = await audit(
      ["--digest", "--project-dir", join(store, "two")],
      options("2026-10-26T09:00:00Z"),
    );

    expect(first.stdout).toStartWith(`Saved ${join(store, "plans/audit/one/2026-10-19.json")}\n`);
    expect(second.stdout).toBe(
      `Saved ${join(store, "plans/audit/two/2026-10-26.json")}\nNothing to compare: no saved run before 2026-10-26.json in ${join(store, "plans/audit/two")}\n`,
    );
  });

  test("the digest saves each run and compares with the newest earlier one", async () => {
    const saved = join(store, "plans/audit", basename(store));
    await mkdir(join(store, "plans/Skills"), { recursive: true });
    await writeFile(join(store, "plans/Skills/baseline-2026-09-18.json"), "{}\n");

    const first = await audit(["--digest"], options("2026-10-19T09:00:00Z"));
    expect(first).toEqual({
      code: 0,
      stdout: `Saved ${saved}/2026-10-19.json\nNothing to compare: no saved run before 2026-10-19.json in ${saved}\n`,
      stderr: "",
    });

    await writeFile(join(saved, "baseline-2026-10-20.json"), "{}\n");
    await writeFile(join(saved, "2026-10-12.json"), "{}\n");

    const second = await audit(["--digest"], options("2026-10-26T09:00:00Z"));
    const rerun = await audit(["--digest"], options("2026-10-26T10:00:00Z"));
    const byHand = await audit(
      ["--compare", join(saved, "2026-10-19.json"), join(saved, "2026-10-26.json")],
      options("2026-10-26T10:00:00Z"),
    );

    expect(second.code).toBe(0);
    expect(second.stdout.split("\n").slice(0, 3)).toEqual([
      `Saved ${saved}/2026-10-26.json`,
      `Compared with ${saved}/2026-10-19.json`,
      "Audit compare, 2026-10-19T09:00:00Z to 2026-10-26T09:00:00Z",
    ]);

    expect(rerun.stdout).toContain("Audit compare, 2026-10-19T09:00:00Z to 2026-10-26T10:00:00Z");
    expect(rerun.stdout).toEndWith(byHand.stdout);
    expect((await readdir(saved)).sort()).toEqual([
      "2026-10-12.json",
      "2026-10-19.json",
      "2026-10-26.json",
      "baseline-2026-10-20.json",
    ]);
  });
});

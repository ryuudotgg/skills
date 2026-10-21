import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, realpath, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTemporary, runCommand, suiteEnvironment } from "../test/process.ts";
import { audit, casefold, encodedProjectDir } from "./audit.ts";

const now = new Date("2026-09-20T12:00:00Z");
let store: string;

beforeEach(async () => {
  store = await mkdtemp(join(tmpdir(), "skills-audit-"));
  await cp(join(import.meta.dir, "fixture"), store, { recursive: true });
  await mkdir(join(store, "claude/broken.jsonl"));

  const old = new Date("2026-08-01T00:00:00");
  await utimes(join(store, "home/.codex/sessions/2026/08/01/rollout-e.jsonl"), old, old);
});

afterEach(async () => {
  await removeTemporary(store);
});

function run(args: readonly string[]) {
  const result = audit([...args, "--project-dir", join(store, "claude")], {
    env: { HOME: join(store, "home"), PLANS_DIR: join(store, "plans") },
    now,
    cwd: store,
  });

  return { ...result, stdout: result.stdout.replaceAll(store, "<store>") };
}

describe("audit on the fixture store", () => {
  test("json values match the golden", async () => {
    const result = run(["--days", "14", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(
      JSON.parse(await readFile(join(import.meta.dir, "expected.json"), "utf8")),
    );
  });

  test("text tables are byte for byte the base script's output", async () => {
    const result = run(["--days=14"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(await readFile(join(import.meta.dir, "expected.txt"), "utf8"));
  });

  test("missing stores become notes, not failures", () => {
    const result = audit(["--json", "--project-dir", join(store, "nowhere")], {
      env: { HOME: join(store, "nohome"), PLANS_DIR: join(store, "noplans") },
      now,
      cwd: store,
    });

    const parsed = JSON.parse(result.stdout);

    expect(result.code).toBe(0);
    expect(parsed.days).toBe(14);
    expect(parsed.tasks.notes).toEqual([
      `${join(store, "noplans")} is unavailable`,
      `${join(store, "noplans/log.tsv")} is unavailable`,
    ]);

    expect(parsed.windows.notes).toEqual([`${join(store, "nowhere")} is unavailable`]);
    expect(parsed.codex.notes).toEqual([`${join(store, "nohome/.codex/sessions")} is unavailable`]);
  });

  test("negative or malformed days exit 2 with nothing on stdout", () => {
    for (const days of ["-1", "x", "", "1_0", " 14", "14 ", "+14", "1.0"]) {
      const result = audit(["--days", days], { env: {}, now, cwd: store });
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
    }
  });

  test("abbreviated flags and invalid days exit 2 with usage on stderr", () => {
    for (const args of [
      ["--da", "14"],
      ["--days=-1"],
      ["--days", "1_0"],
      ["--days="],
      ["--days"],
      ["--json=true"],
      ["--project-dir"],
      ["positional"],
      ["--"],
    ]) {
      const result = audit(args, { env: {}, now, cwd: store });
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toStartWith(
        "usage: skills audit [-h] [--days DAYS] [--json] [--project-dir PROJECT_DIR]\nskills audit: error: ",
      );
    }
  });

  test("help aliases preserve the help output", () => {
    for (const flag of ["-h", "--help"]) {
      const result = audit([flag], { env: {}, now, cwd: store });
      expect(result).toEqual({
        code: 0,
        stdout:
          "usage: skills audit [-h] [--days DAYS] [--json] [--project-dir PROJECT_DIR]\n\nReport task timing from local session stores.\n\noptions:\n  -h, --help            show this help message and exit\n  --days DAYS\n  --json\n  --project-dir PROJECT_DIR\n",
        stderr: "",
      });
    }
  });

  test("project directory forms preserve the given path", () => {
    for (const args of [["--project-dir", "~/unexpanded"], ["--project-dir=~/unexpanded"]]) {
      const result = audit(["--json", ...args], {
        env: { HOME: join(store, "home"), PLANS_DIR: join(store, "plans") },
        now,
        cwd: store,
      });

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).windows.notes).toEqual(["~/unexpanded is unavailable"]);
    }
  });

  test("an empty PLANS_DIR uses the plans reader's home default", () => {
    const result = audit(["--json", "--project-dir", join(store, "claude")], {
      env: { HOME: join(store, "home"), PLANS_DIR: "" },
      now,
      cwd: store,
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).tasks.notes).toEqual([
      `${join(store, "home/Plans")} is unavailable`,
      `${join(store, "home/Plans/log.tsv")} is unavailable`,
    ]);
  });

  test("days reaching before year 1 exit 1 with nothing on stdout", () => {
    for (const days of ["740000", "9".repeat(400)]) {
      const result = audit(["--days", days, "--json"], { env: {}, now, cwd: store });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
    }

    expect(audit(["--days", "739000", "--json"], { env: {}, now, cwd: store }).code).toBe(0);
  });

  test("the default project dir encodes every non alphanumeric character", () => {
    expect(encodedProjectDir("/home", "/Users/ryuu/.t3/worktrees/skills")).toBe(
      "/home/.claude/projects/-Users-ryuu--t3-worktrees-skills",
    );
  });
});

describe("the default store covers every checkout of the repository", () => {
  let root: string;
  let home: string;
  let main: string;
  let live: string;
  let gone: string;

  function records(cwd: string, entries: readonly object[]): string {
    return entries
      .map((entry, index) =>
        JSON.stringify({
          ...entry,
          cwd,
          timestamp: new Date(Date.parse("2026-09-19T10:00:00Z") + index * 300_000).toISOString(),
        }),
      )
      .join("\n");
  }

  async function writeSession(cwd: string, subagent = false): Promise<void> {
    const folder = encodedProjectDir(home, cwd);
    await mkdir(join(folder, "s1/subagents"), { recursive: true });

    const transcript = records(cwd, [
      { type: "user", message: { role: "user", content: "/plans do 7" } },
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "e1", name: "Edit", input: {} }] },
      },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "e1" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
    ]);

    await writeFile(join(folder, "s1.jsonl"), `${transcript}\n`);
    if (!subagent) return;

    const agent = { type: "assistant", agentType: "playbook-agent", message: { model: "m" } };
    await writeFile(join(folder, "s1/subagents/agent-1.jsonl"), records(cwd, [agent, agent]));
  }

  function run(cwd: string, args: readonly string[] = []) {
    const result = audit(["--json", ...args], {
      env: { ...suiteEnvironment(), HOME: home, PLANS_DIR: join(root, "plans") },
      now,
      cwd,
    });

    expect(result.code).toBe(0);
    return JSON.parse(result.stdout).windows;
  }

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "skills-audit-repo-")));
    home = join(root, "home");
    main = join(root, "work/repo");
    live = join(root, "elsewhere/repo-live");
    gone = join(home, ".t3/worktrees/repo/gone");

    const env = { ...suiteEnvironment(), HOME: home, GIT_CONFIG_GLOBAL: "/dev/null" };
    const identity = ["-c", "user.name=audit", "-c", "user.email=audit@example.com"];

    await mkdir(join(root, "work/other"), { recursive: true });

    for (const argv of [
      ["git", "init", "--quiet", "-b", "main", main],
      ["git", "-C", main, ...identity, "commit", "--quiet", "--allow-empty", "-m", "root"],
      ["git", "-C", main, "worktree", "add", "--quiet", "-b", "live", live],
      ["git", "-C", main, "worktree", "add", "--quiet", "-b", "gone", gone],
      ["git", "-C", main, "worktree", "remove", gone],
    ])
      expect((await runCommand(argv, { cwd: root, env })).code).toBe(0);

    await mkdir(join(main, "src"));
    await writeSession(main);
    await writeSession(live);
    await writeSession(gone, true);

    await writeSession(join(root, "work/repo-site"), true);
    await writeSession(join(home, ".t3/worktrees/repo-site/x"), true);
    await writeSession(join(root, "work/other"), true);
  });

  afterEach(async () => {
    await removeTemporary(root);
  });

  test("the main checkout, a live worktree and a deleted one count, look alike names do not", () => {
    for (const cwd of [main, live, join(main, "src")]) {
      const windows = run(cwd);
      expect(windows.found).toBe(3);
      expect(windows.subagents.n).toBe(1);
      expect(windows.notes).toEqual([]);
    }
  });

  test("project dir still reads exactly the folder it names", () => {
    const windows = run(main, [
      "--project-dir",
      encodedProjectDir(home, join(root, "work/repo-site")),
    ]);

    expect(windows.found).toBe(1);
    expect(windows.subagents.n).toBe(1);
  });

  test("outside a git checkout only sessions under the current directory count", () => {
    const windows = run(join(root, "work/other"));
    expect(windows.found).toBe(1);
    expect(windows.subagents.n).toBe(1);
  });
});

describe("casefold normalizes equivalent Unicode spellings", () => {
  test("dotless i stays distinct from I, and sharp s folds to ss", () => {
    expect(casefold("I")).toBe("i");
    expect(casefold("ı")).toBe("ı");
    expect(casefold("Straße")).toBe(casefold("STRASSE"));
    expect(casefold("ẞeta")).toBe("sseta");
  });

  test("final sigma folds to sigma and Cherokee folds to uppercase", () => {
    expect(casefold("ς")).toBe("σ");
    expect(casefold("ꭰᏸᎠ")).toBe("ᎠᏰᎠ");
  });
});

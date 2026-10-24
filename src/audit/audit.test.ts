import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, realpath, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitRead } from "../test/git.ts";
import { removeTemporary, runCommand, suiteEnvironment } from "../test/process.ts";
import { audit, casefold, encodedProjectDir, type Result } from "./audit.ts";
import { decodeGitPath } from "./follow-ups.ts";

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

async function run(
  args: readonly string[],
  terminal?: { width: number },
  env: NodeJS.ProcessEnv = {},
) {
  const result = await audit([...args, "--project-dir", join(store, "claude")], {
    env: { HOME: join(store, "home"), PLANS_DIR: join(store, "plans"), ...env },
    now,
    cwd: store,
    terminal,
  });

  return { ...result, stdout: result.stdout.replaceAll(store, "<store>") };
}

describe("audit on the fixture store", () => {
  test("json values match the golden", async () => {
    const result = await run(["--days", "14", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(
      JSON.parse(await readFile(join(import.meta.dir, "expected.json"), "utf8")),
    );
  });

  test("text tables are byte for byte the base script's output", async () => {
    const result = await run(["--days=14"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(await readFile(join(import.meta.dir, "expected.txt"), "utf8"));
  });

  test("only a terminal gets the pretty view, and json ignores it", async () => {
    const terminal = { width: 100 };
    const pretty = await run(["--days=14"], terminal, { NO_COLOR: "1" });

    expect(pretty.code).toBe(0);
    expect(pretty.stdout).toStartWith(
      "Session audit, last 14 days through 2026-09-20T12:00:00Z\n\nTask durations from the plans trail\n  6 tasks · median 7s · p75 47m\n",
    );

    expect((await run(["--json"], terminal)).stdout).toBe((await run(["--json"])).stdout);
  });

  test("the terminal view honors NO_COLOR and TERM=dumb", async () => {
    const terminal = { width: 100 };
    expect((await run([], terminal)).stdout).toStartWith("\u001b[1mSession audit");

    for (const env of [{ NO_COLOR: "1" }, { TERM: "dumb" }])
      expect((await run([], terminal, env)).stdout).not.toContain("\u001b[");
  });

  test("missing stores become notes, not failures", async () => {
    const result = await audit(["--json", "--project-dir", join(store, "nowhere")], {
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

  test("negative or malformed days exit 2 with nothing on stdout", async () => {
    for (const days of ["-1", "x", "", "1_0", " 14", "14 ", "+14", "1.0"]) {
      const result = await audit(["--days", days], { env: {}, now, cwd: store });
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
    }
  });

  test("abbreviated flags and invalid days exit 2 with usage on stderr", async () => {
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
      const result = await audit(args, { env: {}, now, cwd: store });
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toStartWith(
        "usage: skills audit [-h] [--days DAYS] [--json] [--prs] [--project-dir PROJECT_DIR]\nskills audit: error: ",
      );
    }
  });

  test("help aliases preserve the help output", async () => {
    for (const flag of ["-h", "--help"]) {
      const result = await audit([flag], { env: {}, now, cwd: store });
      expect(result).toEqual({
        code: 0,
        stdout:
          "usage: skills audit [-h] [--days DAYS] [--json] [--prs] [--project-dir PROJECT_DIR]\n\nReport task timing from local session stores.\n\noptions:\n  -h, --help            show this help message and exit\n  --days DAYS\n  --json\n  --prs                 read merged PRs from GitHub\n  --project-dir PROJECT_DIR\n",
        stderr: "",
      });
    }
  });

  test("project directory forms preserve the given path", async () => {
    for (const args of [["--project-dir", "~/unexpanded"], ["--project-dir=~/unexpanded"]]) {
      const result = await audit(["--json", ...args], {
        env: { HOME: join(store, "home"), PLANS_DIR: join(store, "plans") },
        now,
        cwd: store,
      });

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).windows.notes).toEqual(["~/unexpanded is unavailable"]);
    }
  });

  test("an empty PLANS_DIR uses the plans reader's home default", async () => {
    const result = await audit(["--json", "--project-dir", join(store, "claude")], {
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

  test("days reaching before year 1 exit 1 with nothing on stdout", async () => {
    for (const days of ["740000", "9".repeat(400)]) {
      const result = await audit(["--days", days, "--json"], { env: {}, now, cwd: store });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
    }

    expect((await audit(["--days", "739000", "--json"], { env: {}, now, cwd: store })).code).toBe(
      0,
    );
  });

  test("the default project dir encodes every non alphanumeric character", () => {
    expect(encodedProjectDir("/home", "/Users/ryuu/.t3/worktrees/skills")).toBe(
      "/home/.claude/projects/-Users-ryuu--t3-worktrees-skills",
    );
  });
});

describe("follow-up fixes", () => {
  type Pr = { number: number; title: string; mergedAt: string; mergeCommit: { oid: string } };
  type Block = { type: string; [key: string]: unknown };
  type Command = (args: readonly string[]) => Promise<string | undefined>;
  type PrCommit = { headline: string; authoredDate: string };

  const authoredDate = "2026-09-01T12:00:00+04:00";

  function pr(number: number, title: string, daysAgo: number, oid = "a".repeat(40)): Pr {
    return {
      number,
      title,
      mergedAt: new Date(now.getTime() - daysAgo * 86400_000).toISOString(),
      mergeCommit: { oid },
    };
  }

  function use(id: string, command: string): Block {
    return { type: "tool_use", id, name: "Bash", input: { command } };
  }

  function result(id: string, content = "done", isError = false): Block {
    return { type: "tool_result", tool_use_id: id, content, is_error: isError };
  }

  function delegate(id: string, model?: string, name = "mcp__t3_code__delegate_task"): Block {
    return { type: "tool_use", id, name, input: { title: `${id}-impl`, target: { model } } };
  }

  function published(number: number): Block[] {
    return [
      use(`publish-${number}`, "skills publish"),
      result(`publish-${number}`, `https://github.com/example/repo/pull/${number}`),
    ];
  }

  async function transcript(
    name: string,
    blocks: readonly Block[],
    start = "2026-09-07T12:00:00Z",
  ) {
    const records = blocks.map((block, index) =>
      JSON.stringify({
        type: block.type === "tool_result" ? "user" : "assistant",
        timestamp: new Date(Date.parse(start) + index * 1000).toISOString(),
        message: { content: [block] },
      }),
    );

    await mkdir(join(store, "publishing"), { recursive: true });
    await writeFile(join(store, "publishing", `${name}.jsonl`), records.join("\n") + "\n");
  }

  function github(
    prs: readonly Pr[],
    commits: ReadonlyMap<number, readonly PrCommit[] | undefined> = new Map(),
  ): Command {
    return async (args) => {
      if (args[1] === "view") {
        expect(args).toEqual([
          "pr",
          "view",
          expect.any(String),
          "--json",
          "commits",
          "--jq",
          "[.commits[] | {headline: .messageHeadline, authoredDate: .authoredDate}]",
        ]);

        const number = Number(args[2]);
        return JSON.stringify(commits.has(number) ? commits.get(number) : []);
      }

      expect(args).toEqual([
        "pr",
        "list",
        "--state",
        "merged",
        "--search",
        expect.stringMatching(/^merged:>=/u),
        "--limit",
        "1000",
        "--json",
        "number,title,mergedAt,mergeCommit",
      ]);

      return JSON.stringify(prs);
    };
  }

  async function report(gh: Command, args: readonly string[] = ["--prs", "--json"], git?: Command) {
    return await audit([...args, "--project-dir", join(store, "publishing")], {
      env: { HOME: join(store, "home"), PLANS_DIR: join(store, "plans") },
      now,
      cwd: store,
      gh,
      git,
    });
  }

  async function git(args: readonly string[]): Promise<string> {
    const output = await gitRead(store, args);
    expect(output.code).toBe(0);
    return output.stdout.trim();
  }

  async function commit(
    content: string,
    title: string,
    parent?: string | readonly string[],
    path = "file.ts",
    date = authoredDate,
  ): Promise<string> {
    await writeFile(join(store, path), content);

    const blob = await git(["hash-object", "-w", path]);
    await git(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`]);

    const tree = await git(["write-tree"]);
    const output = await runCommand(
      [
        "git",
        "-c",
        "user.name=audit",
        "-c",
        "user.email=audit@example.com",
        "commit-tree",
        tree,
        ...(parent === undefined
          ? []
          : (typeof parent === "string" ? [parent] : parent).flatMap((oid) => ["-p", oid])),
        "-m",
        title,
      ],
      { cwd: store, env: { ...suiteEnvironment(), GIT_AUTHOR_DATE: date } },
    );

    expect(output.code).toBe(0);

    const oid = output.stdout.trim();

    await git(["update-ref", "HEAD", oid]);

    return oid;
  }

  async function history(): Promise<Pr[]> {
    await git(["init", "--initial-branch=main"]);

    const base = await commit("base();\n", "base");
    const first = "base();\nfunction a() {\n  originalA();\n}\n";
    const second = `${first}function b() {\n  changed();\n}\n`;
    const third = `${second}unrelated();\n`;
    const fourth = `${first}function b() {\n  fixed();\nunrelated();\n`;

    const oidA = await commit(first, "feat: a", base);
    const oidB = await commit(second, "feat: b", oidA);
    const oidC = await commit(third, "feat: c", oidB);
    const oidD = await commit(fourth, "fix: b", oidC);
    return [
      pr(1, "feat: a", 11, oidA),
      pr(2, "feat: b", 10, oidB),
      pr(3, "feat: c", 9, oidC),
      pr(4, "fix: b", 5, oidD),
    ];
  }

  const noProvenance: Command = async () => "";

  test("git C quoting decodes octal UTF-8 bytes and control escapes", () => {
    expect(decodeGitPath('"caf\\303\\251.ts"')).toBe("café.ts");
    expect(decodeGitPath('"\\a\\b\\t\\n\\v\\f\\r\\\"\\\\"')).toBe('\x07\b\t\n\v\f\r"\\');
    expect(decodeGitPath('"a/quoted\\\" name.ts"\t')).toBe('a/quoted" name.ts');
    expect(decodeGitPath('"a/back\\\\slash name.ts"\tignored')).toBe("a/back\\slash name.ts");
  });

  test("a two parent fix merge blames the earlier PR", async () => {
    await git(["init", "--initial-branch=main"]);

    const base = await commit("base();\n", "base");
    const feature = await commit("base();\nchanged();\n", "feat: feature", base);
    const side = await commit("base();\nfixed();\n", "fix: side", feature);
    const merge = await commit("base();\nfixed();\n", "merge fix", [feature, side]);
    const output: Result = JSON.parse(
      (await report(github([pr(1, "feat: feature", 10, feature), pr(2, "fix: feature", 5, merge)])))
        .stdout,
    );

    expect(output.follow_up_fixes).toEqual({
      rows: [{ implementer: "unknown", merged: 2, followed_up: 1, share: 0.5 }],
      notes: [],
    });
  });

  test.each(["changed", "second", "third"])(
    "rebase merged features and fixes include %s",
    async (line) => {
      await git(["init", "--initial-branch=main"]);

      const base = await commit("base();\n", "base");
      const first = await commit("base();\nchanged();\n", "feat: first", base);
      const second = await commit(
        "base();\nchanged();\nsecond();\n",
        "feat: second",
        first,
        "file.ts",
        "2026-09-02T12:00:00+04:00",
      );

      const third = await commit(
        "base();\nchanged();\nsecond();\nthird();\n",
        "feat: third",
        second,
        "file.ts",
        "2026-09-03T12:00:00+04:00",
      );

      const repaired = "base();\nchanged();\nsecond();\nthird();\n".replace(
        `${line}();`,
        "fixed();",
      );

      const repair = await commit(repaired, "fix: first", third);
      const last = await commit(`${repaired}last();\n`, "fix: last", repair);

      const output: Result = JSON.parse(
        (
          await report(
            github(
              [pr(1, "feat: feature", 10, third), pr(2, "fix: feature", 5, last)],
              new Map([
                [
                  1,
                  ["feat: first", "feat: second", "feat: third"].map((headline, index) => ({
                    headline,
                    authoredDate: `2026-09-0${index + 1}T08:00:00Z`,
                  })),
                ],
                [
                  2,
                  ["fix: first", "fix: last"].map((headline) => ({
                    headline,
                    authoredDate: "2026-09-01T08:00:00Z",
                  })),
                ],
              ]),
            ),
          )
        ).stdout,
      );

      expect(output.follow_up_fixes).toEqual({
        rows: [{ implementer: "unknown", merged: 2, followed_up: 1, share: 0.5 }],
        notes: [],
      });
    },
  );

  test("squash headlines do not claim earlier first parent commits", async () => {
    await git(["init", "--initial-branch=main"]);

    const base = await commit("base();\n", "base");
    const earlier = await commit("base();\nchanged();\n", "feat: earlier", base);
    const squash = await commit("base();\nchanged();\nsquashed();\n", "feat: squash", earlier);
    const fix = await commit("base();\nfixed();\nsquashed();\n", "fix: earlier", squash);
    const output: Result = JSON.parse(
      (
        await report(
          github(
            [pr(1, "feat: squash", 10, squash), pr(2, "fix: earlier", 5, fix)],
            new Map([
              [
                1,
                ["original first", "original second", "original third"].map((headline) => ({
                  headline,
                  authoredDate,
                })),
              ],
            ]),
          ),
        )
      ).stdout,
    );

    expect(output.follow_up_fixes).toEqual({
      rows: [{ implementer: "unknown", merged: 2, followed_up: 0, share: 0 }],
      notes: [],
    });
  });

  test("failed or malformed commit details fall back to one commit", async () => {
    const prs = await history();
    for (const response of [
      undefined,
      "not json",
      "{}",
      "[1]",
      '["feat: first"]',
      '[{"headline":"feat: first"}]',
      '[{"headline":"feat: first","authoredDate":"invalid"}]',
      new Error("unavailable"),
    ]) {
      const fallback = github(prs);
      const output: Result = JSON.parse(
        (
          await report(async (args) => {
            if (args[1] !== "view" || args[2] !== "2") return await fallback(args);
            if (response instanceof Error) throw response;
            return response;
          })
        ).stdout,
      );

      expect(output.follow_up_fixes).toEqual({
        rows: [{ implementer: "unknown", merged: 4, followed_up: 1, share: 0.25 }],
        notes: ["gh pr view 2 failed"],
      });
    }
  });

  test("squash subject collisions do not claim unrelated commits", async () => {
    await git(["init", "--initial-branch=main"]);

    const base = await commit("base();\n", "base");
    const first = await commit("base();\nchanged();\n", "fix: tests", base);
    const second = await commit("base();\nchanged();\nunrelated();\n", "fix: tests", first);
    const squash = await commit(
      "base();\nchanged();\nunrelated();\nsquashed();\n",
      "feat: last",
      second,
    );

    const fix = await commit(
      "base();\nfixed();\nunrelated();\nsquashed();\n",
      "fix: earlier",
      squash,
    );

    const output: Result = JSON.parse(
      (
        await report(
          github(
            [pr(1, "feat: squash", 10, squash), pr(2, "fix: earlier", 5, fix)],
            new Map([
              [
                1,
                ["fix: tests", "fix: tests", "feat: last"].map((headline) => ({
                  headline,
                  authoredDate: "2026-08-01T08:00:00Z",
                })),
              ],
            ]),
          ),
        )
      ).stdout,
    );

    expect(output.follow_up_fixes).toEqual({
      rows: [{ implementer: "unknown", merged: 2, followed_up: 0, share: 0 }],
      notes: [],
    });
  });

  test.each([
    "café.ts",
    'quoted"file.ts',
    "tab\tfile.ts",
    "back\\slash.ts",
    "my file.ts",
    'quoted" name.ts',
    "back\\slash name.ts",
  ])("fixes blame the special path %s", async (path) => {
    await git(["init", "--initial-branch=main"]);

    const base = await commit("base();\n", "base", undefined, path);
    const feature = await commit("base();\nchanged();\n", "feat: feature", base, path);
    const fix = await commit("base();\nfixed();\n", "fix: feature", feature, path);
    const output: Result = JSON.parse(
      (await report(github([pr(1, "feat: feature", 10, feature), pr(2, "fix: feature", 5, fix)])))
        .stdout,
    );

    expect(output.follow_up_fixes).toEqual({
      rows: [{ implementer: "unknown", merged: 2, followed_up: 1, share: 0.5 }],
      notes: [],
    });
  });

  test("real blame attributes a changed line and duplicate brace only to B", async () => {
    const prs = await history();
    await transcript("a", published(1));
    await transcript("b", [delegate("b", "gpt-6.1-sol"), result("b"), ...published(2)]);
    await transcript("c", [
      use("c", "codex exec -m gpt-6-astra -s workspace-write 'implement'"),
      result("c"),
      ...published(3),
    ]);

    await transcript("d", published(4));

    const output: Result = JSON.parse((await report(github(prs))).stdout);
    expect(output.follow_up_fixes).toEqual({
      rows: [
        { implementer: "lead", merged: 2, followed_up: 0, share: 0 },
        { implementer: "gpt-6-astra", merged: 1, followed_up: 0, share: 0 },
        { implementer: "gpt-6.1-sol", merged: 1, followed_up: 1, share: 1 },
      ],
      notes: [],
    });

    expect(output.windows.found).toBe(0);

    const text = (await report(github(prs), ["--prs"])).stdout;
    expect(text).toContain("Follow-up fixes by implementer\n\nimplementer");
    expect(text).toMatch(/gpt-6\.1-sol\s+1\s+1\s+1\.00/u);
  });

  test("never calls GitHub or git or includes the key without prs", async () => {
    let calls = 0;
    const unexpected: Command = async () => {
      calls++;
      return undefined;
    };

    const output = await report(unexpected, ["--json"], unexpected);
    expect(calls).toBe(0);
    expect(JSON.parse(output.stdout)).not.toHaveProperty("follow_up_fixes");
  });

  test("real provenance still requires a fix title and strictly later merge within 14 days", async () => {
    const prs = await history();
    const original = prs[1]!;
    const fix = prs[3]!;
    const cases: readonly (readonly [string, number, boolean])[] = [
      ["fix(scope)!: boundary", 11, true],
      ["revert: boundary", 11, true],
      ["fix: same time", 25, false],
      ["fix: earlier", 26, false],
      ["Fix: case", 11, false],
      ["feat: title", 11, false],
      ["fix: late", 10, false],
    ];

    for (const [title, daysAgo, follows] of cases) {
      const output: Result = JSON.parse(
        (
          await report(
            github([
              { ...original, mergedAt: pr(2, "", 25).mergedAt },
              { ...fix, title, mergedAt: pr(4, "", daysAgo).mergedAt },
            ]),
            ["--prs", "--json", "--days", "30"],
          )
        ).stdout,
      );

      expect(output.follow_up_fixes?.rows).toEqual([
        {
          implementer: "unknown",
          merged: 2,
          followed_up: follows ? 1 : 0,
          share: follows ? 0.5 : 0,
        },
      ]);

      expect(output.follow_up_fixes?.notes).toEqual([]);
    }
  });

  test("blank old lines and additions alone do not count as follow-ups", async () => {
    await git(["init", "--initial-branch=main"]);

    const base = await commit("base();\n", "base");
    const blank = await commit("base();\n  \n", "feat: blank", base);
    const fix = await commit("base();\n\t\n", "fix: whitespace", blank);
    const added = await commit("base();\n\t\nadded();\n", "fix: adds only", fix);
    const output: Result = JSON.parse(
      (
        await report(
          github([
            pr(1, "feat: blank", 10, blank),
            pr(2, "fix: whitespace", 5, fix),
            pr(3, "fix: adds only", 1, added),
          ]),
        )
      ).stdout,
    );

    expect(output.follow_up_fixes).toEqual({
      rows: [{ implementer: "unknown", merged: 3, followed_up: 0, share: 0 }],
      notes: [],
    });
  });

  test("multiple fixes count an original PR once", async () => {
    const prs = await history();
    const content = await readFile(join(store, "file.ts"), "utf8");
    const another = await commit(
      content.replace("function b() {\n", ""),
      "fix: header",
      prs[3]!.mergeCommit.oid,
    );

    const output: Result = JSON.parse(
      (await report(github([...prs, pr(5, "fix: header", 1, another)]))).stdout,
    );

    expect(output.follow_up_fixes).toEqual({
      rows: [{ implementer: "unknown", merged: 5, followed_up: 1, share: 0.2 }],
      notes: [],
    });
  });

  test("merge PRs include the commits introduced on their second parent", async () => {
    await git(["init", "--initial-branch=main"]);

    const base = await commit("base();\n", "base");
    const side = await commit("base();\nchanged();\n", "feature commit", base);
    const tree = await git(["write-tree"]);
    const merge = await git([
      "-c",
      "user.name=audit",
      "-c",
      "user.email=audit@example.com",
      "commit-tree",
      tree,
      "-p",
      base,
      "-p",
      side,
      "-m",
      "merge feature",
    ]);

    const fix = await commit("base();\nfixed();\n", "fix: feature", merge);
    const output: Result = JSON.parse(
      (await report(github([pr(1, "feat: merged", 10, merge), pr(2, "fix: feature", 5, fix)])))
        .stdout,
    );

    expect(output.follow_up_fixes).toEqual({
      rows: [{ implementer: "unknown", merged: 2, followed_up: 1, share: 0.5 }],
      notes: [],
    });
  });

  test("attribution changes only at matching successful results and a DOING reset", async () => {
    await transcript("actions", [
      delegate("first", "first"),
      result("first"),
      use("search", "rg 'plans start'"),
      result("search", "plans start\n2\tDOING\tname"),
      ...published(1),
      delegate("failed", "failed"),
      result("failed", "error", true),
      ...published(2),
      delegate("other", "other", "any"),
      result("other"),
      ...published(3),
      use("pending", "codex exec -m pending -s workspace-write task"),
      ...published(4),
      result("pending"),
      use("publish-5", "skills publish"),
      delegate("late", "late"),
      result("late"),
      result("publish-5", "/pull/5"),
      use("start", "skills plans start 2"),
      result("unmatched", "2\tDOING\tname"),
      ...published(6),
      result("start", "2\tDOING\tname"),
      ...published(7),
    ]);

    const output: Result = JSON.parse(
      (
        await report(
          github(Array.from({ length: 7 }, (_, index) => pr(index + 1, "feat: task", 1))),
          undefined,
          noProvenance,
        )
      ).stdout,
    );

    expect(output.follow_up_fixes?.rows).toEqual([
      { implementer: "lead", merged: 1, followed_up: 0, share: 0 },
      { implementer: "first", merged: 4, followed_up: 0, share: 0 },
      { implementer: "late", merged: 1, followed_up: 0, share: 0 },
      { implementer: "pending", merged: 1, followed_up: 0, share: 0 },
    ]);
  });

  test("model flags and missing models use only evidenced categories", async () => {
    await transcript("models", [
      use("flag", "codex exec --model 'flagged' -s workspace-write task"),
      result("flag"),
      ...published(1),
      use("config", "codex exec -c 'model=\"configured\"' -s workspace-write task"),
      result("config"),
      ...published(2),
      use("default", "codex exec -s workspace-write task"),
      result("default"),
      ...published(3),
      delegate("missing"),
      result("missing"),
      ...published(4),
    ]);

    const output: Result = JSON.parse(
      (
        await report(
          github(Array.from({ length: 5 }, (_, index) => pr(index + 1, "feat: task", 1))),
          undefined,
          noProvenance,
        )
      ).stdout,
    );

    expect(output.follow_up_fixes?.rows).toEqual([
      { implementer: "configured", merged: 1, followed_up: 0, share: 0 },
      { implementer: "flagged", merged: 1, followed_up: 0, share: 0 },
      { implementer: "unknown", merged: 3, followed_up: 0, share: 0 },
    ]);
  });

  test("older publishing transcripts attribute without changing timing results", async () => {
    await transcript(
      "older",
      [delegate("older", "gpt-6.1-sol"), result("older"), ...published(1)],
      "2026-08-20T12:00:00Z",
    );

    const old = new Date("2026-08-20T12:01:00Z");
    await utimes(join(store, "publishing/older.jsonl"), old, old);

    const plain: Result = JSON.parse((await report(github([]), ["--json"], noProvenance)).stdout);
    const wider: Result = JSON.parse(
      (await report(github([pr(1, "feat: old thread", 1)]), undefined, noProvenance)).stdout,
    );

    expect(wider.follow_up_fixes?.rows).toEqual([
      { implementer: "gpt-6.1-sol", merged: 1, followed_up: 0, share: 0 },
    ]);

    expect(wider.windows).toEqual(plain.windows);
    expect(wider.tasks).toEqual(plain.tasks);
    expect(wider.codex).toEqual(plain.codex);
  });

  test("only matching publish results count and the latest publisher wins", async () => {
    await transcript("old", [delegate("old", "old"), result("old"), ...published(1)]);
    await transcript(
      "new",
      [
        ...published(1),
        result("unrelated", "/pull/2"),
        use("branch", "skills publish"),
        result("branch", "/pull/new/branch"),
      ],
      "2026-09-08T12:00:00Z",
    );

    const output: Result = JSON.parse(
      (
        await report(
          github([pr(1, "feat: one", 2), pr(2, "feat: two", 1)]),
          undefined,
          noProvenance,
        )
      ).stdout,
    );

    expect(output.follow_up_fixes?.rows.map((row) => row.implementer)).toEqual(["lead", "unknown"]);
  });

  test("failed lists produce notes", async () => {
    for (const output of [undefined, "not json", "{}"]) {
      const parsed: Result = JSON.parse((await report(async () => output)).stdout);
      expect(parsed.follow_up_fixes).toEqual({ rows: [], notes: ["gh pr list failed"] });
    }
  });

  test("missing merge commits are noted once and contribute no provenance", async () => {
    const prs = await history();
    const missing = "f".repeat(40);
    const output: Result = JSON.parse(
      (await report(github([prs[1]!, { ...prs[3]!, mergeCommit: { oid: missing } }]))).stdout,
    );

    expect(output.follow_up_fixes).toEqual({
      rows: [{ implementer: "unknown", merged: 2, followed_up: 0, share: 0 }],
      notes: [`merge commit of #4 (${missing}) is not in the local clone, run git fetch`],
    });
  });

  test("each git failure invalidates both introduced commits and blame", async () => {
    const prs = await history();
    const content = await readFile(join(store, "file.ts"), "utf8");
    const another = await commit(
      content.replace("fixed();", "repaired();"),
      "fix: repair",
      prs[3]!.mergeCommit.oid,
    );

    prs.push(pr(5, "fix: repair", 1, another));

    for (const operation of ["cat-file", "rev-list", "diff", "blame"]) {
      const injected: Command = async (args) => {
        if (args.includes(operation) && args.some((arg) => arg.includes(prs[3]!.mergeCommit.oid)))
          return undefined;

        const output = await gitRead(store, args);
        return output.code === 0 ? output.stdout : undefined;
      };

      const output: Result = JSON.parse((await report(github(prs), undefined, injected)).stdout);
      expect(output.follow_up_fixes?.rows[0]?.followed_up).toBe(0);
      expect(output.follow_up_fixes?.notes).toHaveLength(1);
      expect(output.follow_up_fixes?.notes[0]).toContain("#4");
      expect(output.follow_up_fixes?.notes[0]).toContain(prs[3]!.mergeCommit.oid);
    }
  });

  test("lists from the cutoff day, filters exact timestamps and limits gh/git concurrency", async () => {
    let active = 0;
    let peak = 0;
    let calls = 0;
    const injected: Command = async (args) => {
      active++;
      peak = Math.max(peak, active);
      calls++;

      await Bun.sleep(1);
      active--;

      if (args[1] === "view") return "[]";

      return args[0] === "rev-list" ? `${"a".repeat(40)} ${"b".repeat(40)}` : "";
    };

    const prs = Array.from({ length: 20 }, (_, index) => pr(index + 1, "feat: included", 14));
    const output: Result = JSON.parse(
      (
        await report(
          async (args) => {
            if (args[1] === "view") return await injected(args);

            expect(args).toContain("merged:>=2026-09-06");

            return JSON.stringify([
              ...prs,
              { ...pr(21, "feat: too early", 14), mergedAt: "2026-09-06T11:59:59Z" },
            ]);
          },
          undefined,
          injected,
        )
      ).stdout,
    );

    expect(peak).toBe(8);
    expect(calls).toBe(60);
    expect(output.follow_up_fixes?.rows[0]?.merged).toBe(20);
  });

  test("the 1000 record list limit is visible", async () => {
    const output: Result = JSON.parse(
      (
        await report(
          github(Array.from({ length: 1000 }, (_, index) => pr(index + 1, "feat: task", 1))),
          undefined,
          noProvenance,
        )
      ).stdout,
    );

    expect(output.follow_up_fixes?.notes).toEqual([
      "gh pr list returned its 1000 limit, older PRs are missing",
    ]);

    expect(output.follow_up_fixes?.rows[0]?.merged).toBe(1000);
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

  async function run(cwd: string, args: readonly string[] = []) {
    const result = await audit(["--json", ...args], {
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

  test("the main checkout, a live worktree and a deleted one count, look alike names do not", async () => {
    for (const cwd of [main, live, join(main, "src")]) {
      const windows = await run(cwd);
      expect(windows.found).toBe(3);
      expect(windows.subagents.n).toBe(1);
      expect(windows.notes).toEqual([]);
    }
  });

  test("project dir still reads exactly the folder it names", async () => {
    const windows = await run(main, [
      "--project-dir",
      encodedProjectDir(home, join(root, "work/repo-site")),
    ]);

    expect(windows.found).toBe(1);
    expect(windows.subagents.n).toBe(1);
  });

  test("outside a git checkout only sessions under the current directory count", async () => {
    const windows = await run(join(root, "work/other"));
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

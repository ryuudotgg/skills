import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fixtureGit, writeFixture } from "../test/fixtures.ts";
import { removeTemporary, runCommand, suiteEnvironment } from "../test/process.ts";
import { faultGit, stackCase } from "../test/stack-fixture.ts";
import { readIndex } from "./index-tsv.ts";
import { surfaceValue } from "./lint.ts";
import { chainVerb, handoffVerb } from "./verbs.ts";

const bin = resolve(import.meta.dir, "../../skills/playbook/bin/skills");
const header = "id\tslug\tstatus\tpri\teffort\tblocked_by\tctx\tbranch\tupdated\tnote";
let temporary: string;
let plans: string;
let repo: string;

function row(id: string, slug: string, status: string, pri: string, effort: string, blockedBy: string, branch: string, note = "-") {
  return [id, slug, status, pri, effort, blockedBy, "-", branch, "2026-09-26", note].join("\t");
}

async function index(project: string, rows: readonly string[]): Promise<string> {
  const path = join(plans, project, "index.tsv");
  await writeFixture(plans, `${project}/index.tsv`, `${[header, ...rows].join("\n")}\n`);
  return path;
}

async function skills(args: readonly string[], cwd = repo) {
  return runCommand([bin, ...args], { cwd, env: { ...suiteEnvironment(), PLANS_DIR: plans }, timeout: 60_000 });
}

async function initRepo(path: string): Promise<void> {
  await fixtureGit(temporary, ["init", "-q", "-b", "main", path]);
  await fixtureGit(path, ["-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"]);
}

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), "skills-plans-"));
  plans = join(temporary, "plans");
  repo = join(temporary, "fixture");
  await initRepo(repo);
});

afterEach(async () => {
  await removeTemporary(temporary);
});

describe("plans frontier", () => {
  const rows = [
    row("001", "ready", "TODO", "P0", "XS", "-", "-", "ready note"),
    row("002", "released", "DONE", "P1", "S", "-", "-"),
    row("003", "released-ready", "TODO", "P1", "S", "002", "-", "released note"),
    row("010", "base-review", "REVIEW", "P1", "M", "-", "feat/base"),
    row("011", "stacks-base", "TODO", "P1", "S", "010", "-"),
    row("012", "child-review", "REVIEW", "P1", "M", "010", "feat/child"),
    row("013", "stacks-child", "TODO", "P1", "S", "010,012", "-"),
    row("020", "other-review", "REVIEW", "P1", "M", "-", "feat/other"),
    row("021", "two-stacks", "TODO", "P1", "S", "010,020", "-"),
    row("030", "waits-todo", "TODO", "P2", "S", "031", "-"),
    row("031", "todo-blocker", "TODO", "P2", "S", "-", "-"),
    row("040", "in-progress", "DOING", "P1", "M", "-", "feat/progress"),
    row("060", "late-ready", "TODO", "P0", "XS", "-", "-"),
  ];

  test("test-frontier: prints ready, blocked, review and doing rows", async () => {
    await index("fixture", rows);
    const result = await skills(["plans", "frontier", "fixture"]);

    expect(result.stdout).toBe(`READY 6
001  P0  XS  ready                              ready note
060  P0  XS  late-ready                         -
003  P1  S   released-ready                     released note
011  P1  S   stacks-base                        stacks on 010 (feat/base)
013  P1  S   stacks-child                       stacks on 012 (feat/child)
031  P2  S   todo-blocker                       -

BLOCKED 2
021  P1  two-stacks                         waits on 010,020 (two stacks)
030  P2  waits-todo                         waits on 031

REVIEW 3
010  P1  base-review                        feat/base
012  P1  child-review                       feat/child
020  P1  other-review                       feat/other

DOING 040 in-progress feat/progress
`);
  });

  test("test-frontier: --next and --stacks-on", async () => {
    await index("fixture", rows);

    expect((await skills(["plans", "frontier", "--next", "fixture"])).stdout).toBe("001\n");
    expect((await skills(["plans", "frontier", "--stacks-on", "012", "fixture"])).stdout).toBe("013\n");
    expect((await skills(["plans", "frontier", "--stacks-on", "010", "fixture"])).stdout).toBe("011\n");
    expect((await skills(["plans", "frontier", "--stacks-on", "020", "fixture"])).stdout).toBe("");

    const missing = await skills(["plans", "frontier", "--next", "missing"]);
    expect(missing.code).toBe(1);
    expect(missing.stdout).toBe("");
  });

  test("test-frontier: detects the project from a linked worktree and names known projects", async () => {
    const source = join(temporary, "src/skills");
    await initRepo(source);
    await index("Skills", [row("001", "skills-ready", "TODO", "P1", "S", "-", "-")]);
    await index("Other", [row("001", "other-ready", "TODO", "P1", "S", "-", "-")]);

    await fixtureGit(source, ["worktree", "add", "-q", "-b", "linked", join(temporary, "wt/t3code-0000")]);
    const linked = await skills(["plans", "frontier"], join(temporary, "wt/t3code-0000"));
    expect(linked.stdout).toStartWith("READY 1\n");
    expect(linked.stdout).toContain("skills-ready");

    const nomatch = join(temporary, "src/nomatch");
    await initRepo(nomatch);
    const miss = await skills(["plans", "frontier"], nomatch);
    expect(miss.code).toBe(0);
    expect(miss.stdout).toBe(
      `no project under ${plans} matches 'nomatch'. Pass one: /plans <Project>\nknown projects: Other Skills \n`,
    );
  });
});

describe("plans handoff", () => {
  test("refuses a failed recorded base read without changing the index", async () => {
    const path = await index("fixture", [row("010", "base", "DOING", "P1", "S", "-", "feat/a")]);
    await fixtureGit(repo, ["config", "branch.feat/a.skills-base", "origin/main"]);
    const before = await readFile(path);
    const testCase = await stackCase("skills-handoff-");
    try {
      testCase.env.PLANS_DIR = plans;
      await faultGit(testCase);
      testCase.env.FAULT_PATTERN = "config --get branch.feat/a.skills-base";

      const result = await testCase.run((args, io) => handoffVerb(args, "plans handoff", io), ["fixture", "010"], repo);
      expect([result.code, result.stdout]).toEqual([1, ""]);
      expect(result.stderr).toContain("handoff: cannot read branch.feat/a.skills-base");
      expect(await readFile(path)).toEqual(before);
    } finally {
      await testCase.dispose();
    }
  });

  test("refuses a recorded base cycle without changing the index", async () => {
    const path = await index("fixture", [row("010", "base", "DOING", "P1", "S", "-", "feat/a")]);
    await fixtureGit(repo, ["config", "branch.feat/a.skills-base", "feat/b"]);
    await fixtureGit(repo, ["config", "branch.feat/b.skills-base", "feat/a"]);
    const before = await readFile(path);
    const testCase = await stackCase("skills-handoff-");
    try {
      testCase.env.PLANS_DIR = plans;
      const result = await testCase.run((args, io) => handoffVerb(args, "plans handoff", io), ["fixture", "010"], repo);
      expect([result.code, result.stdout, result.stderr]).toEqual([1, "", "handoff: cycle in recorded bases at feat/a\n"]);
      expect(await readFile(path)).toEqual(before);
    } finally {
      await testCase.dispose();
    }
  });

  test("test-handoff: prints the stack and the stacking plans without writing the index", async () => {
    const path = await index("fixture", [
      row("010", "base", "DOING", "P1", "S", "-", "feat/base"),
      row("011", "child", "TODO", "P1", "S", "010", "-"),
      row("020", "top", "DOING", "P1", "S", "-", "feat/top"),
      row("030", "todo", "TODO", "P1", "S", "-", "-"),
    ]);

    for (const [branch, base] of [
      ["feat/top", "feat/mid"],
      ["feat/mid", "feat/low"],
      ["feat/low", "origin/main"],
      ["feat/base", "origin/main"],
    ])
      await fixtureGit(repo, ["config", `branch.${branch}.skills-base`, base ?? ""]);

    const before = await readFile(path);
    const base = await skills(["plans", "handoff", "fixture", "010"]);
    expect(base.stdout).toBe("babysit feat/base\nnext 011\n");

    const top = await skills(["plans", "handoff", "fixture", "020"]);
    expect(top.stdout).toBe("babysit feat/low feat/mid feat/top\n");
    expect(await readFile(path)).toEqual(before);
    expect((await readdir(join(plans, "fixture"))).sort()).toEqual(["index.tsv"]);

    const todo = await skills(["plans", "handoff", "fixture", "030"]);
    expect([todo.code, todo.stderr]).toEqual([1, "handoff: row 030 is TODO, not DOING\n"]);

    const missing = await skills(["plans", "handoff", "fixture", "099"]);
    expect([missing.code, missing.stderr]).toEqual([1, "handoff: id 099 not found\n"]);
  });

  test("test-handoff: refuses a checkout of another project", async () => {
    await index("fixture", [row("010", "base", "DOING", "P1", "S", "-", "feat/base")]);
    const other = join(temporary, "other");
    await initRepo(other);

    const result = await skills(["plans", "handoff", "fixture", "010"], other);
    expect([result.code, result.stdout, result.stderr]).toEqual([
      1,
      "",
      "handoff: this checkout is other, not a checkout of fixture\n",
    ]);
  });
});

describe("plans chain", () => {
  test("test-preflight cycle: chain refuses a recorded base cycle", async () => {
    await fixtureGit(repo, ["config", "branch.feat/a.skills-base", "feat/b"]);
    await fixtureGit(repo, ["config", "branch.feat/b.skills-base", "feat/a"]);
    const testCase = await stackCase("skills-chain-");
    try {
      const result = await testCase.run((args, io) => chainVerb(args, "plans chain", io), ["feat/a"], repo);
      expect([result.code, result.stdout, result.stderr]).toEqual([1, "", "chain: cycle in recorded bases at feat/a\n"]);
    } finally {
      await testCase.dispose();
    }
  });
});

describe("plans lint", () => {
  test("test-lint: reports frontmatter, critical, forward pointers and intentions", async () => {
    await index("fixture", [
      row("036", "matcher", "DONE", "P1", "S", "-", "-"),
      row("042", "migration", "DONE", "P1", "S", "-", "-"),
      row("039", "release", "DROPPED", "P1", "S", "-", "-"),
      row("044", "followup", "TODO", "P1", "S", "-", "-"),
      row("046", "review", "REVIEW", "P1", "S", "-", "feat/review"),
    ]);

    const plan = (frontmatter: string) => `---\nsurface: plans\n${frontmatter}---\n# Plan\n## Acceptance\n- [ ] It passes lint.\n`;

    await writeFixture(plans, "fixture/001-valid.md", plan(""));
    await writeFixture(plans, "fixture/002-critical-true.md", plan("critical: true   \n"));
    await writeFixture(plans, "fixture/003-critical-false.md", plan("critical: false\n"));
    await writeFixture(plans, "fixture/004-critical-invalid.md", plan("critical: yes\n"));

    await writeFixture(plans, "fixture/045-cleanup.md", plan(""));
    await writeFixture(
      plans,
      "fixture/ctx-fixture.md",
      [
        "The context remains pending until 042 closes.",
        "The next migration, which is 036, still owns the work.",
        "The release remains blocked by 039.",
        "The reporting cleanup wants its own plan.",
        "The work continues until 046 closes.",
        "Since 036 the matcher is anchored.",
        "It was fixed by 042.",
        "The cleanup wants its own plan, which is 044.",
        "```",
        "The example says until 042 closes.",
        "```",
        "",
      ].join("\n"),
    );

    await writeFixture(
      plans,
      "fixture/ctx-regression.md",
      [
        "Wait until 044 closes and until 042 closes.",
        "The cleanup wants its own plan, which is 099.",
        "The context is pending 099.",
        "The cleanup wants its own plan, tracked as 045.",
        "After 042 shipped, the matcher was anchored; 044 ships the remaining cleanup.",
        "",
      ].join("\n"),
    );

    const result = await skills(["plans", "lint", "fixture"]);
    expect([result.code, result.stdout]).toEqual([
      1,
      `004-critical-invalid.md: critical: must be true or false, got "yes"
ctx-fixture.md: line 1: forward pointer at 042 (DONE): until 042
ctx-fixture.md: line 2: forward pointer at 036 (DONE): which is 036
ctx-fixture.md: line 3: forward pointer at 039 (DROPPED): blocked by 039
ctx-fixture.md: line 4: intention with no id: wants its own plan
ctx-regression.md: line 1: forward pointer at 042 (DONE): until 042
ctx-regression.md: line 2: intention with no id: wants its own plan
7 error(s)
`,
    ]);

    expect((await skills(["plans", "lint", "fixture", "001"])).stdout).toBe("ok\n");
  });

  test("a dangling plan symlink is skipped without hiding the other files", async () => {
    await index("fixture", []);
    await writeFixture(plans, "fixture/001-bad.md", "no frontmatter\n");
    await symlink("/nonexistent", join(plans, "fixture/zz-gone.md"));

    const all = await skills(["plans", "lint", "fixture"]);
    expect([all.code, all.stdout]).toEqual([1, "001-bad.md: no frontmatter\n1 error(s)\n"]);
    expect((await skills(["plans", "lint", "fixture", ""])).stdout).toBe(all.stdout);
  });

  test("surface values keep their first and last character unless quoted", async () => {
    expect(surfaceValue("surface: plans")).toBe("plans");
    expect(surfaceValue("surface: ab")).toBe("ab");
    expect(surfaceValue("surface: 'quoted'  ")).toBe("quoted");
    expect(surfaceValue('surface: "x"')).toBe("x");
    expect(surfaceValue('surface: "')).toBe('"');

    await index("fixture", []);
    await writeFixture(plans, "fixture/001-short.md", "---\nsurface: ab\n---\n");
    await writeFixture(plans, "fixture/002-empty.md", "---\nsurface: ''\n---\n");

    expect((await skills(["plans", "lint", "fixture", "001"])).stdout).toBe("ok\n");
    expect((await skills(["plans", "lint", "fixture", "002"])).stdout).toBe(
      "002-empty.md: frontmatter has no surface: value\n1 error(s)\n",
    );
  });
});

describe("plans index writes", () => {
  test("set-row updates one row, stamps it and caps the note", async () => {
    const path = await index("fixture", [row("001", "one", "TODO", "P1", "S", "-", "-"), row("002", "two", "TODO", "P1", "S", "-", "-")]);

    const result = await skills(["plans", "set-row", "fixture", "001", "DOING", "feat/one", `a\tb${"x".repeat(200)}`]);
    const [first, second] = readIndex(path);
    expect(result.stdout).toBe(`${(await readFile(path, "utf8")).split("\n")[1]}\n`);
    expect([first?.status, first?.branch, first?.note.length, first?.note.slice(0, 3)]).toEqual(["DOING", "feat/one", 100, "a b"]);
    expect(second?.status).toBe("TODO");

    expect((await skills(["plans", "set-row", "fixture", "009", "DONE"])).stderr).toBe("id not found: 009\n");
    expect((await skills(["plans", "set-row", "fixture", "001", "LATER"])).stderr).toBe("bad status: LATER\n");
  });

  test("concurrent set-row loops and adds lose no row and allocate no id twice", async () => {
    const path = await index("fixture", [row("001", "one", "TODO", "P1", "S", "-", "-"), row("002", "two", "TODO", "P1", "S", "-", "-")]);
    const env = { ...suiteEnvironment(), PLANS_DIR: plans, SKILLS: bin };

    const loops = [
      'for i in $(seq 50); do "$SKILLS" plans set-row fixture 001 DOING - "one $i" >/dev/null || exit 1; done',
      'for i in $(seq 50); do "$SKILLS" plans set-row fixture 002 REVIEW - "two $i" >/dev/null || exit 1; done',
      'for i in $(seq 10); do "$SKILLS" plans add fixture "added-$i" P2 S >/dev/null || exit 1; done',
    ];

    const results = await Promise.all(loops.map((script) => runCommand(["sh", "-c", script], { cwd: repo, env, timeout: 120_000 })));
    expect(results.map((result) => result.code)).toEqual([0, 0, 0]);

    const rows = readIndex(path);
    expect(rows.map((entry) => entry.id)).toEqual(Array.from({ length: 12 }, (_, offset) => String(offset + 1).padStart(3, "0")));
    expect(rows.slice(2).map((entry) => entry.slug).sort()).toEqual(Array.from({ length: 10 }, (_, offset) => `added-${offset + 1}`).sort());
    expect([rows[0]?.note, rows[1]?.note]).toEqual(["one 50", "two 50"]);
    expect((await readdir(join(plans, "fixture"))).sort()).toEqual([".index.tsv.lock", "index.tsv"]);
  }, 120_000);

  test("a writer killed while holding the lock does not wedge the next write", async () => {
    const path = await index("fixture", [row("001", "one", "TODO", "P1", "S", "-", "-")]);
    const holder = Bun.spawn(
      [
        "bun",
        "-e",
        `const { dlopen, FFIType } = require("bun:ffi");
        const libc = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
        const descriptor = require("node:fs").openSync(process.argv[1], "a");
        if (libc.symbols.flock(descriptor, 6) !== 0) process.exit(3);
        console.log("held");
        setInterval(() => {}, 1000);`,
        join(plans, "fixture/.index.tsv.lock"),
      ],
      { stdout: "pipe" },
    );

    const reader = holder.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("held\n");

    const waiting = skills(["plans", "set-row", "fixture", "001", "DOING"]);
    await Bun.sleep(300);
    expect(readIndex(path)[0]?.status).toBe("TODO");

    holder.kill("SIGKILL");
    const result = await waiting;
    expect(result.code).toBe(0);
    expect(readIndex(path)[0]?.status).toBe("DOING");
    expect((await readdir(join(plans, "fixture"))).sort()).toEqual([".index.tsv.lock", "index.tsv"]);
  });

  test("set-row keeps the bytes of rows it does not touch", async () => {
    const odd = "002\ttwo\tTODO\tP1\tS\t-\t-\t-\t2026-09-26\t-\textra";
    const path = await index("fixture", [row("001", "one", "TODO", "P1", "S", "-", "-"), odd, ""]);

    await chmod(path, 0o600);

    await skills(["plans", "set-row", "fixture", "001", "DOING"]);
    expect((await readFile(path, "utf8")).split("\n").slice(2)).toEqual([odd, "", ""]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("add appends the next id with TODO and no branch", async () => {
    const path = await index("fixture", [row("007", "seven", "DONE", "P1", "S", "-", "-")]);

    const result = await skills(["plans", "add", "fixture", "new-plan", "P1", "M", "007", "ctx-batch", "label"]);
    const added = readIndex(path)[1];
    expect(result.stdout).toBe(`${(await readFile(path, "utf8")).split("\n")[2]}\n`);
    expect([added?.id, added?.status, added?.blocked_by, added?.ctx, added?.branch, added?.note]).toEqual([
      "008",
      "TODO",
      "007",
      "ctx-batch",
      "-",
      "label",
    ]);

    await writeFixture(plans, "fixture/done/012-landed.md");
    await writeFixture(plans, "fixture/010-written.md");
    expect((await skills(["plans", "add", "fixture", "written", "P1", "S"])).stdout).toStartWith("010\twritten\t");
    expect((await skills(["plans", "add", "fixture", "fresh", "P1", "S"])).stdout).toStartWith("013\tfresh\t");

    await writeFixture(plans, "fixture/010-clash.md");
    const clash = await skills(["plans", "add", "fixture", "clash", "P1", "S"]);
    expect([clash.code, clash.stderr]).toEqual([
      1,
      "id 010 is already in the index as written; renumber 010-clash.md and every reference to it\n",
    ]);

    const again = await skills(["plans", "add", "fixture", "written", "P1", "S"]);
    expect([again.code, again.stdout.slice(0, 12)]).toEqual([0, "010\twritten\t"]);

    const twin = await skills(["plans", "add", "fixture", "fresh", "P1", "S"]);
    expect([twin.code, twin.stderr]).toEqual([1, "slug fresh is already in the index as 013\n"]);

    const bad = await skills(["plans", "add", "fixture", "Bad Slug", "P1", "M"]);
    expect([bad.code, bad.stderr]).toEqual([1, "slug is not kebab case: Bad Slug\n"]);
  });

  test("log creates its header once and flattens the detail", async () => {
    await skills(["plans", "log", "fixture", "001", "start", "feat/one"]);
    await skills(["plans", "log", "fixture", "001", "note", `a\tb\nc${"x".repeat(200)}`]);

    const lines = (await readFile(join(plans, "log.tsv"), "utf8")).split("\n");
    expect(lines[0]).toBe("ts\tproject\tid\tevent\tdetail");
    expect(lines[1]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\tfixture\t001\tstart\tfeat\/one$/);
    expect(lines[2]?.split("\t")[4]).toBe(`a b c${"x".repeat(135)}`);
    expect(lines).toHaveLength(4);
  });

  test("add refuses past 999, and writes flatten tabs and newlines in every field", async () => {
    const path = await index("fixture", [row("999", "last", "TODO", "P1", "S", "-", "-")]);

    const full = await skills(["plans", "add", "fixture", "overflow", "P1", "S"]);
    expect([full.code, full.stderr]).toEqual([1, "no three digit id is left\n"]);

    await skills(["plans", "set-row", "fixture", "999", "DOING", "feat/a\tb\nc"]);
    expect(readIndex(path)).toHaveLength(1);
    expect(readIndex(path)[0]?.branch).toBe("feat/a b c");

    await skills(["plans", "log", "fixture", "9\t9", "ev\nent", "x"]);
    const lines = (await readFile(join(plans, "log.tsv"), "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]?.split("\t").slice(1)).toEqual(["fixture", "9 9", "ev ent", "x"]);
  });

  test("a project name that leaves the plans directory is refused", async () => {
    await index("fixture", [row("001", "one", "TODO", "P1", "S", "-", "-")]);

    for (const verb of [["set-row", "../fixture", "001", "DONE"], ["add", "..", "x", "P1", "S"], ["lint", "a/b"]]) {
      const result = await skills(["plans", ...verb]);
      expect([result.code, result.stderr]).toEqual([1, `invalid project: ${verb[1]}\n`]);
    }
  });
});

describe("review fixes", () => {
  test("lint ignores headings and list items inside fenced blocks", async () => {
    await index("fixture", []);
    await writeFixture(
      plans,
      "fixture/001-fenced.md",
      "---\nsurface: plans\n---\n## Acceptance\n1. one\n\n    ```\n## Steps\n2. two\n3. three\n4. four\n```\n",
    );

    expect((await skills(["plans", "lint", "fixture", "001"])).stdout).toBe("ok\n");
  });

  test("a repeated blocker id still stacks on its review row", async () => {
    await index("fixture", [
      row("010", "base", "REVIEW", "P1", "M", "-", "feat/base"),
      row("011", "twice", "TODO", "P1", "S", "010,010", "-"),
    ]);

    expect((await skills(["plans", "frontier", "--stacks-on", "010", "fixture"])).stdout).toBe("011\n");
  });

  test("lint reads loose headings and every acceptance list marker", async () => {
    await index("fixture", []);
    await writeFixture(plans, "fixture/001-loose.md", "---\nsurface: plans\n---\n##\tSteps\n##   Acceptance\n+ one\n  - two\n*   three\n1) four\n");

    expect((await skills(["plans", "lint", "fixture", "001"])).stdout).toBe(
      '001-loose.md: 4 acceptance items, cap is 3\n001-loose.md: banned section "## Steps"\n2 error(s)\n',
    );
  });

  test("add ignores a directory named like a plan file", async () => {
    await index("fixture", [row("003", "three", "DONE", "P1", "S", "-", "-")]);
    await writeFixture(plans, "fixture/010-folder.md/inner", "");
    expect((await skills(["plans", "add", "fixture", "folder", "P1", "S"])).stdout).toStartWith("004\tfolder\t");
  });

  test("lint reads a plan saved with CRLF line endings", async () => {
    await index("fixture", []);
    await writeFixture(plans, "fixture/001-crlf.md", "---\r\nsurface: plans\r\n---\r\n## Steps\r\n");

    expect((await skills(["plans", "lint", "fixture", "001"])).stdout).toBe(
      '001-crlf.md: banned section "## Steps"\n1 error(s)\n',
    );
  });
});

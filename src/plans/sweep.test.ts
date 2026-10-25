import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Io } from "../io.ts";
import { commitFixture, fixtureGit, writeFixture } from "../test/fixtures.ts";
import { removeTemporary, suiteEnvironment } from "../test/process.ts";
import { withLock } from "../lock.ts";
import { readIndex, scratchLock, today } from "./index-tsv.ts";
import { sweepVerb } from "./sweep.ts";
import { closePlan, markStarted } from "./verbs.ts";

const stubBin = resolve(import.meta.dir, "../../scripts/stubs");
const usage = "skills plans sweep <Project> [--dry-run]";
const header = "id\tslug\tstatus\tpri\teffort\tblocked_by\tctx\tbranch\tupdated\tnote";
const fields =
  "number,state,baseRefName,mergeCommit,headRefOid,title,isCrossRepository,mergedAt,closedAt";

const temporary: string[] = [];

type Tree = {
  directory: string;
  repo: string;
  plans: string;
  scratch: string;
  env: NodeJS.ProcessEnv;
};

type Pr = {
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
  base?: string;
  head?: string;
  title?: string;
  at?: string;
  fork?: boolean;
};

function row(id: string, slug: string, status: string, branch: string): string {
  return [id, slug, status, "P1", "S", "-", "-", branch, "2026-10-01", "-"].join("\t");
}

function event(id: string, name: string, ts: string, project = "fixture"): string {
  return [ts, project, id, name, name === "done" ? "Shipped" : "feat/x"].join("\t");
}

async function createTree(): Promise<Tree> {
  const directory = await mkdtemp(join(tmpdir(), "skills-sweep-"));
  temporary.push(directory);

  const tree: Tree = {
    directory,
    repo: join(directory, "fixture"),
    plans: join(directory, "plans"),
    scratch: join(directory, "scratch"),
    env: {
      ...suiteEnvironment(),
      PATH: `${stubBin}:${process.env.PATH ?? ""}`,
      PLANS_DIR: join(directory, "plans"),
      GH_STUB_DIR: join(directory, "gh"),
      GH_STUB_LOG: join(directory, "gh.log"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  };

  await mkdir(join(directory, "gh"));
  await mkdir(tree.scratch);

  const origin = join(directory, "origin.git");
  await fixtureGit(directory, ["init", "--quiet", "--bare", "-b", "main", origin]);
  await fixtureGit(directory, ["init", "--quiet", "-b", "main", tree.repo]);
  await fixtureGit(tree.repo, ["remote", "add", "origin", origin]);

  await writeFixture(tree.repo, "base", "base\n");
  await commitFixture(tree.repo);

  for (const branch of ["feat/a", "feat/b", "feat/c"]) {
    await fixtureGit(tree.repo, ["checkout", "--quiet", "-b", branch, "main"]);
    await writeFixture(tree.repo, branch.slice(5), `${branch}\n`);
    await commitFixture(tree.repo);
  }

  await fixtureGit(tree.repo, ["checkout", "--quiet", "main"]);
  await fixtureGit(origin, ["fetch", "--quiet", tree.repo, "+refs/heads/*:refs/heads/*"]);

  await index(tree, [
    row("1", "a", "REVIEW", "feat/a"),
    row("2", "b", "REVIEW", "feat/b"),
    row("3", "c", "REVIEW", "feat/c"),
  ]);

  await trail(tree, [
    ...["1", "2", "3"].map((id) => event(id, "start", "2026-10-01T00:00:00Z")),
    ...["1", "2", "3"].map((id) => event(id, "handback", "2026-10-01T01:00:00Z")),
  ]);

  for (const [id, slug] of [
    ["1", "a"],
    ["2", "b"],
    ["3", "c"],
  ])
    await writeFixture(
      tree.plans,
      `fixture/${id}-${slug}.md`,
      `# ${id} ${slug}\n\n## Landed\n\nBranch feat/${slug}, not merged yet.\nShipped ${slug}.\n`,
    );

  await prs(tree, "feat/a", [{ number: 11, state: "MERGED", head: await tip(tree, "feat/a") }]);
  await prs(tree, "feat/b", [{ number: 12, state: "OPEN" }]);
  await prs(tree, "feat/c", [{ number: 13, state: "CLOSED" }]);
  return tree;
}

async function index(tree: Tree, rows: readonly string[], project = "fixture"): Promise<void> {
  await writeFixture(tree.plans, `${project}/index.tsv`, `${[header, ...rows].join("\n")}\n`);
}

async function trail(tree: Tree, lines: readonly string[]): Promise<void> {
  await writeFixture(
    tree.plans,
    "log.tsv",
    `${["ts\tproject\tid\tevent\tdetail", ...lines].join("\n")}\n`,
  );
}

async function tip(tree: Tree, branch: string): Promise<string> {
  return (await fixtureGit(tree.repo, ["rev-parse", branch])).trim();
}

function prKey(branch: string): string {
  const args = [
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "all",
    "--json",
    fields,
    "--limit",
    "200",
  ];

  return args.join(" ").replace(/[^A-Za-z0-9._-]/gu, "_");
}

async function appendTrail(tree: Tree, line: string): Promise<void> {
  const path = join(tree.plans, "log.tsv");
  await writeFile(path, `${await readFile(path, "utf8")}${line}\n`);
}

async function prs(tree: Tree, branch: string, entries: readonly Pr[]): Promise<void> {
  const body = entries.map((pr) => ({
    number: pr.number,
    state: pr.state,
    baseRefName: pr.base ?? "main",
    mergeCommit: pr.state === "MERGED" ? { oid: "abcdef1234567890" } : null,
    headRefOid: pr.head ?? "0".repeat(40),
    title: pr.title ?? `feat: ship ${branch.slice(5)}`,
    isCrossRepository: pr.fork ?? false,
    mergedAt: pr.state === "MERGED" ? (pr.at ?? "2026-10-02T00:00:00Z") : null,
    closedAt: pr.state === "OPEN" ? null : (pr.at ?? "2026-10-02T00:00:00Z"),
  }));

  await writeFile(join(tree.directory, "gh", prKey(branch)), JSON.stringify(body));
}

async function sweep(tree: Tree, args: readonly string[] = ["fixture"], cwd = tree.repo) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: Io = {
    cwd,
    env: tree.env,
    out: (text) => stdout.push(text),
    err: (text) => stderr.push(text),
    capture: true,
  };

  const code = await sweepVerb(args, usage, io, tree.scratch);
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

async function snapshot(tree: Tree) {
  const names = (await readdir(tree.plans, { recursive: true })).sort();
  const files = await Promise.all(
    names
      .filter((name) => name.endsWith(".md") || name.endsWith(".tsv"))
      .map(async (name) => [name, await readFile(join(tree.plans, name), "utf8")]),
  );

  return { names, files };
}

afterEach(async () => {
  for (const directory of temporary) await removeTemporary(directory);
  temporary.length = 0;
});

describe("plans sweep", () => {
  test("closes only the merged row, reports the others, and a rerun has nothing left", async () => {
    const tree = await createTree();

    const first = await sweep(tree);
    expect([first.code, first.stderr]).toEqual([0, ""]);
    expect(first.stdout).toBe(
      [
        "closed 1 #11 a",
        "open 2 #12",
        "unmerged 3 #13: closed without merging, the operator's call",
        "closed 1 of 3",
        "",
      ].join("\n"),
    );

    const rows = (await readFile(join(tree.plans, "fixture/index.tsv"), "utf8")).split("\n");
    expect(rows[1]?.split("\t")).toEqual([
      "1",
      "a",
      "DONE",
      "P1",
      "S",
      "-",
      "-",
      "feat/a",
      today(),
      "feat: ship a",
    ]);

    expect(rows[2]).toBe(row("2", "b", "REVIEW", "feat/b"));
    expect(rows[3]).toBe(row("3", "c", "REVIEW", "feat/c"));
    expect(existsSync(join(tree.plans, "fixture/1-a.md"))).toBe(false);
    expect(await readFile(join(tree.plans, "fixture/done/1-a.md"), "utf8")).toBe(
      "# 1 a\n\n## Landed\n\nMerged as abcdef1 (PR 11, branch feat/a).\nShipped a.\n",
    );

    expect(existsSync(join(tree.plans, "fixture/3-c.md"))).toBe(true);
    expect(
      (await readFile(join(tree.plans, "log.tsv"), "utf8")).trimEnd().split("\n").at(-1),
    ).toMatch(/\tfixture\t1\tdone\tfeat: ship a$/);

    const before = await snapshot(tree);
    const second = await sweep(tree);
    expect([second.code, second.stderr]).toEqual([0, ""]);
    expect(second.stdout).toBe(
      [
        "open 2 #12",
        "unmerged 3 #13: closed without merging, the operator's call",
        "nothing left to close",
        "",
      ].join("\n"),
    );

    expect(await snapshot(tree)).toEqual(before);
  });

  test("dry run lists the row and PR it would close and writes nothing", async () => {
    const tree = await createTree();
    await mkdir(join(tree.scratch, "plans-1"));
    const before = await snapshot(tree);

    const result = await sweep(tree, ["fixture", "--dry-run"]);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe(
      [
        "would close 1 #11 a",
        "open 2 #12",
        "unmerged 3 #13: closed without merging, the operator's call",
        `would remove ${join(tree.scratch, "plans-1")}`,
        "would close 1 of 3",
        "",
      ].join("\n"),
    );

    expect(await snapshot(tree)).toEqual(before);
    expect(existsSync(join(tree.scratch, "plans-1"))).toBe(true);
  });

  test("removes a closed row's scratch, not its sibling or a symlink target", async () => {
    const tree = await createTree();
    const outside = join(tree.directory, "outside");

    await writeFixture(outside, "keep.txt", "keep\n");
    await writeFixture(tree.scratch, "plans-1/nested/output.txt", "arm output\n");
    await symlink(join(outside, "keep.txt"), join(tree.scratch, "plans-1/link"));
    await symlink(outside, join(tree.scratch, "plans-1/nested/dir-link"));
    await writeFixture(tree.scratch, "plans-2/notes.txt", "live\n");

    const result = await sweep(tree);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`removed ${join(tree.scratch, "plans-1")}\n`);

    expect(existsSync(join(tree.scratch, "plans-1"))).toBe(false);
    expect(
      lstatSync(join(tree.scratch, "plans-1/link"), { throwIfNoEntry: false }),
    ).toBeUndefined();

    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("keep\n");
    expect(await readFile(join(tree.scratch, "plans-2/notes.txt"), "utf8")).toBe("live\n");
  });

  test("leaves a DOING row whose thread still works, then closes it after the handback", async () => {
    const tree = await createTree();
    await index(tree, [row("1", "a", "DOING", "feat/a")]);
    await trail(tree, [event("1", "start", "2026-10-01T00:00:00Z")]);
    await mkdir(join(tree.scratch, "plans-1"));

    const live = await sweep(tree);
    expect([live.code, live.stdout]).toEqual([
      0,
      "live 1 #11: merged while its thread still works\nclosed 0 of 1\n",
    ]);

    expect(existsSync(join(tree.plans, "fixture/1-a.md"))).toBe(true);
    expect(existsSync(join(tree.scratch, "plans-1"))).toBe(true);

    await appendTrail(tree, event("1", "handback", "2026-10-03T00:00:00Z"));

    const later = await sweep(tree);
    expect(later.stdout).toBe(
      ["closed 1 #11 a", `removed ${join(tree.scratch, "plans-1")}`, "closed 1 of 1", ""].join(
        "\n",
      ),
    );

    expect(existsSync(join(tree.scratch, "plans-1"))).toBe(false);
  });

  test.each([
    ["open", [row("1", "other", "DOING", "feat/other")], [], "Other 1 is DOING"],
    [
      "started then reset",
      [row("1", "other", "TODO", "-")],
      [event("1", "start", "2026-10-01T00:00:00Z", "Other")],
      "Other 1 is TODO after a start",
    ],
    [
      "closed before its handback",
      [row("1", "other", "DONE", "feat/other")],
      [event("1", "start", "2026-10-01T00:00:00Z", "Other")],
      "Other 1 has not handed back",
    ],
  ])("keeps scratch whose id another project holds: %s", async (_name, rows, events, reason) => {
    const tree = await createTree();
    await index(tree, rows, "Other");
    for (const line of events) await appendTrail(tree, line);
    await mkdir(join(tree.scratch, "plans-1"));

    const result = await sweep(tree);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`kept ${join(tree.scratch, "plans-1")}: ${reason}\n`);
    expect(existsSync(join(tree.scratch, "plans-1"))).toBe(true);
  });

  test("an unreadable index in any project keeps every scratch and exits 1", async () => {
    const tree = await createTree();
    await writeFixture(tree.plans, "Broken/index.tsv");
    await writeFile(join(tree.plans, "Broken/index.tsv"), Buffer.from([0xff, 0xfe, 0x00]));
    await mkdir(join(tree.scratch, "plans-1"));

    const result = await sweep(tree);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      `kept ${join(tree.scratch, "plans-1")}: Broken index.tsv is unreadable\n`,
    );

    expect(existsSync(join(tree.scratch, "plans-1"))).toBe(true);
  });

  test("a scratch path that is a symlink is left, with its target", async () => {
    const tree = await createTree();
    const elsewhere = join(tree.directory, "elsewhere");
    await writeFixture(elsewhere, "keep.txt", "keep\n");
    await symlink(elsewhere, join(tree.scratch, "plans-1"));

    const result = await sweep(tree);
    expect(result.stdout).not.toContain("plans-1\n");
    expect(lstatSync(join(tree.scratch, "plans-1")).isSymbolicLink()).toBe(true);
    expect(await readFile(join(elsewhere, "keep.txt"), "utf8")).toBe("keep\n");
  });

  test("a PR merged before the row's last start belongs to an earlier row on the branch", async () => {
    const tree = await createTree();
    await trail(tree, [event("1", "start", "2026-10-03T00:00:00Z")]);
    const before = await snapshot(tree);

    const result = await sweep(tree);
    expect(result.stdout.split("\n")[0]).toBe("nopr 1 feat/a");
    expect(result.stdout).toContain("nothing left to close\n");
    expect((await snapshot(tree)).files).toEqual(before.files);
  });

  test.each([
    [
      "merged into a stacked parent",
      [{ number: 11, state: "MERGED", base: "feat/z" }] as Pr[],
      "elsewhere 1 #11: merged into feat/z, not the default branch",
      0,
    ],
    ["a fork PR only", [{ number: 11, state: "MERGED", fork: true }] as Pr[], "nopr 1 feat/a", 0],
    [
      "a list at the limit",
      Array.from({ length: 200 }, (_, offset) => ({ number: offset + 1, state: "CLOSED" })) as Pr[],
      "unreadable 1 feat/a: 200 or more PRs, the list may be cut",
      1,
    ],
  ])("%s does not close the row", async (_name, entries, line, code) => {
    const tree = await createTree();
    await prs(tree, "feat/a", entries);

    const result = await sweep(tree);
    expect(result.code).toBe(code);
    expect(result.stdout.split("\n")[0]).toBe(line);
    expect(existsSync(join(tree.plans, "fixture/1-a.md"))).toBe(true);
  });

  test.each([
    [
      "no start in log.tsv",
      async (tree: Tree) => trail(tree, []),
      "unstarted 1 #11: merged, but log.tsv has no start for the row",
    ],
    [
      "gh failing",
      async (tree: Tree) => rm(join(tree.directory, "gh", prKey("feat/a"))),
      "unreadable 1 feat/a: gh pr list failed",
    ],
  ])("a merged row left open by %s exits 1", async (_name, setup, line) => {
    const tree = await createTree();
    await setup(tree);

    const result = await sweep(tree);
    expect(result.code).toBe(1);
    expect(result.stdout.split("\n")[0]).toBe(line);
    expect(result.stdout.trimEnd().split("\n").at(-1)).toBe("closed 0 of 3");
    expect(existsSync(join(tree.plans, "fixture/1-a.md"))).toBe(true);
  });

  test("a merged row with no Landed section is named for a draft and exits 1", async () => {
    const tree = await createTree();
    const plan = join(tree.plans, "fixture/1-a.md");
    await writeFile(plan, "# 1 a\n\nNo draft yet.\n");
    const before = await snapshot(tree);

    const result = await sweep(tree);
    expect(result.code).toBe(1);
    expect(result.stdout.split("\n")[0]).toBe(`draft 1 #11 ${plan}`);
    expect(result.stdout.trimEnd().split("\n").at(-1)).toBe("closed 0 of 3");
    expect(await snapshot(tree)).toEqual(before);
  });

  test.each([
    ["clean", async () => {}],
    ["dirty", async (path: string) => writeFile(join(path, "untracked.txt"), "work\n")],
  ])("reports the merged branch's checkout as %s and leaves it", async (state, touch) => {
    const tree = await createTree();
    const holder = join(tree.directory, "holder");
    await fixtureGit(tree.repo, ["worktree", "add", "--quiet", holder, "feat/a"]);
    await touch(holder);

    const result = await sweep(tree);
    expect(result.stdout).toContain(`checkout 1 ${realpathSync(holder)} ${state}\n`);
    expect(existsSync(holder)).toBe(true);
  });

  test("reports a checkout an earlier close left behind", async () => {
    const tree = await createTree();
    await index(tree, [row("4", "d", "DONE", "feat/c"), row("2", "b", "REVIEW", "feat/b")]);
    await prs(tree, "feat/c", [{ number: 14, state: "MERGED", head: await tip(tree, "feat/c") }]);
    const holder = join(tree.directory, "holder");
    await fixtureGit(tree.repo, ["worktree", "add", "--quiet", holder, "feat/c"]);

    const result = await sweep(tree);
    expect(result.stdout).toBe(
      ["open 2 #12", `checkout 4 ${realpathSync(holder)} clean`, "nothing left to close", ""].join(
        "\n",
      ),
    );
  });

  test("a guard that fails under the index lock refuses the close and writes nothing", async () => {
    const tree = await createTree();
    const before = await snapshot(tree);

    let calls = 0;
    const result = await closePlan({
      index: join(tree.plans, "fixture/index.tsv"),
      project: "fixture",
      id: "1",
      status: "DONE",
      note: "Shipped",
      stamp: async () => "Merged as abcdef1 (PR 11, branch feat/a).",
      dryRun: false,
      env: tree.env,
      guard: () => (++calls === 1 ? undefined : "row 1 was started or reviewed during the sweep"),
    });

    expect(result).toEqual({
      kind: "refused",
      reason: "row 1 was started or reviewed during the sweep",
      draftless: undefined,
    });

    expect(calls).toBe(2);
    expect((await snapshot(tree)).files).toEqual(before.files);
  });

  test("waits on the scratch lock before it claims a directory", async () => {
    const tree = await createTree();
    await index(tree, [row("1", "a", "DONE", "feat/a")]);
    await mkdir(join(tree.scratch, "plans-1"));

    let pending: ReturnType<typeof sweep> | undefined;
    await withLock(scratchLock(tree.env), "test", async () => {
      pending = sweep(tree);
      await Bun.sleep(1500);
      expect(existsSync(join(tree.scratch, "plans-1"))).toBe(true);
    });

    const result = await pending;
    expect(result?.stdout).toBe(
      `removed ${join(tree.scratch, "plans-1")}\nnothing left to close\n`,
    );

    expect(existsSync(join(tree.scratch, "plans-1"))).toBe(false);
  });

  test("a start claims its row under the same scratch lock", async () => {
    const tree = await createTree();
    const path = join(tree.plans, "fixture/index.tsv");
    await index(tree, [row("1", "a", "TODO", "-")]);
    const [listed] = readIndex(path);
    if (!listed) throw new Error("fixture row missing");

    let pending: ReturnType<typeof markStarted> | undefined;
    await withLock(scratchLock(tree.env), "test", async () => {
      pending = markStarted(path, "fixture", "1", "feat/a", listed, tree.env);
      await Bun.sleep(500);
      expect(readIndex(path)[0]?.status).toBe("TODO");
    });

    await pending;
    expect(readIndex(path)[0]?.status).toBe("DOING");
  });

  test("removes trash a crashed sweep left behind", async () => {
    const tree = await createTree();
    const trash = join(tree.scratch, ".plans-7.sweep-0b6b6c43-4a52-4c39-9d0e-3c1c1f6f2f11");
    await writeFixture(trash, "left.txt", "left\n");
    await mkdir(join(tree.scratch, ".plans-7.other"));

    const result = await sweep(tree);
    expect(result.stdout).toContain(`removed ${trash}\n`);
    expect(existsSync(trash)).toBe(false);
    expect(existsSync(join(tree.scratch, ".plans-7.other"))).toBe(true);
  });

  test("refuses outside a checkout of the project without reading PRs", async () => {
    const tree = await createTree();
    const before = await snapshot(tree);

    const result = await sweep(tree, ["fixture"], tree.directory);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("sweep: not inside a git repository");
    expect(await readFile(tree.env.GH_STUB_LOG ?? "", "utf8").catch(() => "")).toBe("");
    expect(await snapshot(tree)).toEqual(before);
  });
});

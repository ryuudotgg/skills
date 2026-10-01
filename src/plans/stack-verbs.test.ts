import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { commitFixture, fixtureGit, writeFixture } from "../test/fixtures.ts";
import { removeTemporary, runCommand, suiteEnvironment } from "../test/process.ts";
import { QUERY } from "./stack-verbs.ts";

const bin = resolve(import.meta.dir, "../../skills/playbook/bin/skills");
const sourceSkills = resolve(import.meta.dir, "../../skills");
const stubBin = resolve(import.meta.dir, "../../scripts/stubs");
const header = "id\tslug\tstatus\tpri\teffort\tblocked_by\tctx\tbranch\tupdated\tnote";
let temporary: string;
let repo: string;
let root: string;
let fixtures: string;
let log: string;
let env: NodeJS.ProcessEnv;

type Thread = { isResolved: boolean; comments: { nodes: { url: string; author: { login: string } | null }[] } };

function thread(number: number, isResolved: boolean, login: string | null): Thread {
  return {
    isResolved,
    comments: {
      nodes: [{ url: `https://github.com/o/r/pull/1#discussion_r${number}`, author: login === null ? null : { login } }],
    },
  };
}

function page(nodes: readonly Thread[], pageInfo?: { hasNextPage: boolean; endCursor: string | null }): string {
  return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes, ...(pageInfo ? { pageInfo } : {}) } } } } });
}

function prArgs(branch: string): string[] {
  return ["pr", "list", "--head", branch, "--state", "all", "--json", "number,state", "--jq", '.[] | "\\(.state) \\(.number)"'];
}

function threadArgs(number: string, cursor?: string): string[] {
  return [
    "api", "graphql", "-F", "owner={owner}", "-F", "repo={repo}", "-F", `number=${number}`,
    ...(cursor ? ["-f", `after=${cursor}`] : []), "-F", `query=${QUERY}`,
  ];
}

async function fixture(args: readonly string[], output: string, code = 0, prefix = false): Promise<void> {
  const key = args.join(" ").replace(/[^A-Za-z0-9._-]/gu, "_");
  const path = join(fixtures, `${key}${prefix ? ".prefix" : ""}`);
  await writeFile(path, output);
  await writeFile(`${path}.exit`, `${code}\n`);
}

async function threads(number: string, output: string, code = 0, cursor?: string): Promise<void> {
  await fixture(threadArgs(number, cursor).slice(0, -1), output, code, true);
}

async function below(base = "feat/b", cwd = repo) {
  return runCommand([bin, "--root", root, "plans", "below", "fixture", base], { cwd, env, timeout: 60_000 });
}

async function calls(): Promise<string[]> {
  return (await readFile(log, "utf8")).trimEnd().split("\n").filter(Boolean);
}

async function refusal(base: string, reason: string): Promise<void> {
  const result = await below(base);
  expect([result.code, result.stdout, result.stderr]).toEqual([1, "", `below: ${reason}\n`]);
}

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), "skills-stack-verbs-"));
  repo = join(temporary, "fixture");
  root = join(temporary, "skills");

  fixtures = join(temporary, "gh");
  log = join(temporary, "gh.log");
  env = {
    ...suiteEnvironment(),
    PATH: `${stubBin}:${process.env.PATH ?? ""}`,
    PLANS_DIR: join(temporary, "plans"),
    SKILLS_CONF: join(temporary, "skills.conf"),
    GH_STUB_DIR: fixtures,
    GH_STUB_LOG: log,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };

  await mkdir(fixtures);
  await mkdir(join(root, "playbook/scripts"), { recursive: true });
  await mkdir(join(root, "greptile"));

  await copyFile(join(sourceSkills, "playbook/scripts/reviewers.sh"), join(root, "playbook/scripts/reviewers.sh"));
  await copyFile(join(sourceSkills, "greptile/reviewer.conf"), join(root, "greptile/reviewer.conf"));
  await writeFile(env.SKILLS_CONF ?? "", "DELIVERY=prs\n");
  await writeFile(log, "");
});

afterEach(async () => {
  await removeTemporary(temporary);
});

describe("plans below", () => {
  beforeEach(async () => {
    const origin = join(temporary, "origin.git");
    await fixtureGit(temporary, ["init", "--quiet", "--bare", "-b", "main", origin]);
    await writeFixture(origin, "hooks/post-receive", '#!/bin/sh\nwhile read -r old new refname; do\n  printf "push %s\\n" "$refname" >> "$GH_STUB_LOG"\ndone\n');
    await chmod(join(origin, "hooks/post-receive"), 0o755);

    await fixtureGit(temporary, ["init", "--quiet", "-b", "main", repo]);
    await fixtureGit(repo, ["remote", "add", "origin", origin]);
    await writeFixture(repo, "base", "base\n");
    await commitFixture(repo);

    for (const [branch, base, file] of [["feat/a", "main", "a"], ["feat/b", "feat/a", "b"]] as const) {
      await fixtureGit(repo, ["checkout", "--quiet", "-b", branch, base]);
      await fixtureGit(repo, ["config", `branch.${branch}.skills-base`, base === "main" ? "origin/main" : base]);
      await writeFixture(repo, file, `${file}\n`);
      await commitFixture(repo);
    }

    await fixtureGit(repo, ["checkout", "--quiet", "main"]);
    await fixtureGit(origin, ["fetch", "--quiet", repo, "+refs/heads/*:refs/heads/*"]);
    await fixtureGit(repo, ["fetch", "--quiet", "origin"]);
    await writeFixture(temporary, "plans/fixture/index.tsv", `${header}\n1\ta\tREVIEW\tP1\tS\t-\t-\tfeat/a\t2026-09-26\t-\n2\tb\tREVIEW\tP1\tS\t1\t-\tfeat/b\t2026-09-26\t-\n3\tnew\tTODO\tP1\tS\t2\t-\t-\t2026-09-26\t-\n`);
  });

  test("test-preflight resolved: accepts resolved layers without checks or writes", async () => {
    await fixture(prArgs("feat/a"), "OPEN 1");
    await fixture(prArgs("feat/b"), "OPEN 2");
    await threads("1", page([]));
    await threads("2", page([]));

    const result = await below();
    expect([result.code, result.stdout, result.stderr]).toEqual([0, "", ""]);
    expect(await calls()).toEqual([prArgs("feat/a"), threadArgs("1"), prArgs("feat/b"), threadArgs("2")].map((args) => args.join(" ")));

    expect(await readFile(log, "utf8")).not.toContain("pr checks");
    expect(await readFile(log, "utf8")).not.toContain("pulls/");
    expect(await fixtureGit(repo, ["for-each-ref", "refs/heads/feat/new"])).toBe("");
  });

  test("test-preflight unresolved: names the thread and never pushes", async () => {
    await fixture(prArgs("feat/a"), "OPEN 1");
    await fixture(prArgs("feat/b"), "OPEN 2");
    await threads("1", page([thread(11, false, "greptile-apps")]));
    await threads("2", page([]));

    const result = await below();
    expect([result.code, result.stdout, result.stderr]).toEqual([
      1, "", "open\t1\tfeat/a\t1\thttps://github.com/o/r/pull/1#discussion_r11\nbelow: unresolved Greptile threads below the base\n",
    ]);

    expect((await calls()).filter((call) => call.startsWith("push "))).toEqual([]);
  });

  test("test-preflight trunk: reads no PRs and prints nothing", async () => {
    const before = await calls();
    const result = await below("origin/main");

    expect([result.code, result.stdout, result.stderr]).toEqual([0, "", ""]);
    expect(await calls()).toEqual(before);
  });

  test("test-preflight merged: skips the merged layer's threads", async () => {
    await fixture(prArgs("feat/a"), "MERGED 5");
    await fixture(prArgs("feat/b"), "OPEN 2");
    await threads("2", page([]));

    const result = await below();
    expect([result.code, result.stdout, result.stderr]).toEqual([0, "", ""]);
    expect(await readFile(log, "utf8")).not.toContain("number=5");
    expect(await calls()).toEqual([prArgs("feat/a"), prArgs("feat/b"), threadArgs("2")].map((args) => args.join(" ")));
  });

  test("test-preflight unowned: refuses a branch without an index row", async () => {
    await refusal("feat/unowned", "feat/unowned is not an owned branch");
    expect(await calls()).toEqual([]);
  });

  test("test-preflight closed: refuses a PR closed without merging", async () => {
    await fixture(prArgs("feat/a"), "CLOSED 7");
    await refusal("feat/a", "PR for feat/a was closed without merging");
    expect(await calls()).toEqual([prArgs("feat/a").join(" ")]);
  });

  test("test-preflight empty: refuses a branch without a PR", async () => {
    await fixture(prArgs("feat/a"), "");
    await refusal("feat/a", "feat/a has no PR");
    expect(await calls()).toEqual([prArgs("feat/a").join(" ")]);
  });

  test("test-preflight threads-failed: refuses a failed thread read", async () => {
    await fixture(prArgs("feat/a"), "OPEN 1");
    await threads("1", "", 1);

    await refusal("feat/a", "gh failed reading review threads for feat/a");
    expect(await calls()).toEqual([prArgs("feat/a").join(" "), threadArgs("1").join(" ")]);
  });

  test("test-preflight wrong checkout: preserves branches, config and the gh log", async () => {
    const other = join(temporary, "other");
    await fixtureGit(temporary, ["init", "--quiet", "-b", "main", other]);
    await commitFixture(other);
    await fixtureGit(other, ["config", "branch.feat/scratch.skills-base", "origin/main"]);
    await fixtureGit(other, ["branch", "feat/scratch"]);

    const branches = await fixtureGit(other, ["branch", "--list"]);
    const config = await fixtureGit(other, ["config", "--get-regexp", "skills-base"]);
    const before = await calls();

    const result = await below("feat/b", other);
    expect([result.code, result.stdout, result.stderr]).toEqual([1, "", "below: this checkout is other, not a checkout of fixture\n"]);
    expect(await fixtureGit(other, ["branch", "--list"])).toBe(branches);
    expect(await fixtureGit(other, ["config", "--get-regexp", "skills-base"])).toBe(config);
    expect(await calls()).toEqual(before);
  });

  test("150 threads: finds only reviewer thread 120 on the second page", async () => {
    await fixture(prArgs("feat/a"), "OPEN 1");
    const first = Array.from({ length: 100 }, (_, offset) => thread(offset + 1, offset % 2 === 0, offset % 2 === 0 ? "greptile-apps" : "developer"));
    const second = Array.from({ length: 50 }, (_, offset) => thread(offset + 101, offset !== 19, "GREPTILE-APPS[bot]"));
    await threads("1", page(first, { hasNextPage: true, endCursor: "cursor100" }));
    await threads("1", page(second, { hasNextPage: false, endCursor: null }), 0, "cursor100");

    const result = await below("feat/a");
    expect([result.code, result.stdout, result.stderr]).toEqual([
      1, "", "open\t1\tfeat/a\t1\thttps://github.com/o/r/pull/1#discussion_r120\nbelow: unresolved Greptile threads below the base\n",
    ]);

    expect(await calls()).toEqual([prArgs("feat/a"), threadArgs("1"), threadArgs("1", "cursor100")].map((args) => args.join(" ")));
    expect((await calls())[2]).toContain("-f after=cursor100 -F query=");
  });

  test.each([
    ["unparsable JSON", "not json"],
    ["errors key", '{"errors":[],"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}'],
    ["null pullRequest", '{"data":{"repository":{"pullRequest":null}}}'],
    ["null reviewThreads", '{"data":{"repository":{"pullRequest":{"reviewThreads":null}}}}'],
    ["missing nodes", '{"data":{"repository":{"pullRequest":{"reviewThreads":{}}}}}'],
    ["nonarray nodes", '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":{}}}}}}'],
    ["empty cursor", page([], { hasNextPage: true, endCursor: "" })],
    ["null cursor", page([], { hasNextPage: true, endCursor: null })],
    ["nonstring cursor", '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[],"pageInfo":{"hasNextPage":true,"endCursor":7}}}}}}'],
  ])("refuses %s at the thread JSON boundary", async (_name, output) => {
    await fixture(prArgs("feat/a"), "OPEN 1");
    await threads("1", output);
    await refusal("feat/a", "gh failed reading review threads for feat/a");
  });

  test("buffers open lines until every layer succeeds", async () => {
    await fixture(prArgs("feat/a"), "OPEN 1");
    await fixture(prArgs("feat/b"), "CLOSED 2");
    await threads("1", page([thread(11, false, "greptile-apps")]));

    await refusal("feat/b", "PR for feat/b was closed without merging");
  });

  test("reads the first OPEN PR even after MERGED and CLOSED PRs", async () => {
    await fixture(prArgs("feat/a"), "MERGED 5\nCLOSED 6\nOPEN 1\nOPEN 2");
    await threads("1", page([]));

    const result = await below("feat/a");
    expect([result.code, result.stdout, result.stderr]).toEqual([0, "", ""]);
    expect(await calls()).toEqual([prArgs("feat/a"), threadArgs("1")].map((args) => args.join(" ")));
  });

  test("does not query threads with no installed reviewers but still checks PR state", async () => {
    await rm(join(root, "greptile/reviewer.conf"));
    await fixture(prArgs("feat/a"), "OPEN 1");

    const result = await below("feat/a");
    expect([result.code, result.stdout, result.stderr]).toEqual([0, "", ""]);
    expect(await calls()).toEqual([prArgs("feat/a").join(" ")]);

    await fixture(prArgs("feat/a"), "CLOSED 7");
    await refusal("feat/a", "PR for feat/a was closed without merging");
  });

  test("ignores null authors, human starters and resolved reviewer threads", async () => {
    await fixture(prArgs("feat/a"), "OPEN 1");
    await threads("1", page([thread(1, false, null), thread(2, false, "developer"), thread(3, true, "greptile-apps")]));

    const result = await below("feat/a");
    expect([result.code, result.stdout, result.stderr]).toEqual([0, "", ""]);
  });

  test("refuses unreadable declarations before reading a chain or PR", async () => {
    await writeFile(join(root, "greptile/reviewer.conf"), "NAME=Greptile\n");

    const result = await below();
    expect([result.code, result.stdout]).toEqual([1, ""]);
    expect(result.stderr).toEndWith("below: cannot read reviewer declarations\n");
    expect(await calls()).toEqual([]);
  });

  test("refuses a failed PR read", async () => {
    await fixture(prArgs("feat/a"), "", 1);
    await refusal("feat/a", "gh pr list failed for feat/a");
  });

  test("caps thread pagination at 100 pages without printing buffered lines", async () => {
    await fixture(prArgs("feat/a"), "OPEN 1");
    const repeating = page([thread(11, false, "greptile-apps")], { hasNextPage: true, endCursor: "again" });
    await threads("1", repeating);
    await threads("1", repeating, 0, "again");

    await refusal("feat/a", "gh failed reading review threads for feat/a");
    expect((await calls()).filter((call) => call.startsWith("api graphql"))).toHaveLength(100);
  }, 20_000);

  test("usage names both registered verbs", async () => {
    for (const [verb, usage] of [
      ["below", "skills plans below <Project> <base>"],
      ["stack-base", "skills plans stack-base [--cut] <Project> <id>"],
    ] as const) {
      const result = await runCommand([bin, "--root", root, "plans", verb], { cwd: repo, env });
      expect([result.code, result.stdout, result.stderr]).toEqual([2, "", `usage: ${usage}\n`]);
    }
  });
});

describe("plans stack-base", () => {
  function row(id: string, slug: string, status: string, blockedBy: string, branch: string): string {
    return [id, slug, status, "P1", "S", blockedBy, "-", branch, "2026-09-26", "-"].join("\t");
  }

  function blockerArgs(branch: string): string[] {
    return ["pr", "list", "--head", branch, "--state", "all", "--json", "state,mergeCommit", "--jq", '.[] | [.state, .mergeCommit.oid // "-"] | join(" ")'];
  }

  async function stackBase(id: string, cut = false, cwd = repo) {
    return runCommand([bin, "--root", root, "plans", "stack-base", ...(cut ? ["--cut"] : []), "fixture", id], { cwd, env, timeout: 60_000 });
  }

  async function refuseBase(id: string, reason: string): Promise<void> {
    const result = await stackBase(id);
    expect([result.code, result.stdout]).toEqual([1, ""]);
    expect(result.stderr).toContain(reason);
  }

  async function doingRows(): Promise<void> {
    await appendFile(join(temporary, "plans/fixture/index.tsv"), `${[
      row("120", "busy", "DOING", "-", "feat/busy"),
      row("130", "held", "DOING", "-", "feat/held"),
      row("131", "after-held", "TODO", "130", "-"),
    ].join("\n")}\n`);
  }

  async function withoutGh(): Promise<void> {
    const path = join(temporary, "nogh");
    await mkdir(path);

    for (const tool of ["sh", "git", "awk", "sed", "cut", "tr", "dirname", "basename", "cat", "bun"]) {
      const executable = Bun.which(tool);
      if (!executable) throw new Error(`fixture tool not found: ${tool}`);
      await symlink(executable, join(path, tool));
    }

    env = { ...env, PATH: path };
    expect(Bun.which("gh", { PATH: env.PATH })).toBeNull();
  }

  beforeEach(async () => {
    const origin = join(temporary, "origin.git");
    await fixtureGit(temporary, ["init", "--quiet", "--bare", "-b", "main", origin]);
    await fixtureGit(temporary, ["init", "--quiet", "-b", "main", repo]);
    await fixtureGit(repo, ["remote", "add", "origin", origin]);
    await commitFixture(repo);

    for (const [branch, base] of [["feat/open", "main"], ["feat/child", "feat/open"], ["feat/other", "main"]] as const) {
      await fixtureGit(repo, ["checkout", "--quiet", "-b", branch, base]);
      await fixtureGit(repo, ["-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", branch]);
    }

    await fixtureGit(repo, ["checkout", "--quiet", "main"]);
    await fixtureGit(repo, ["-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "squash of feat/merged"]);
    const mergeOid = (await fixtureGit(repo, ["rev-parse", "HEAD"])).trimEnd();

    for (const [branch, base] of [["feat/rebased", "main"], ["feat/squashed-bottom", "main"], ["feat/on-squashed", "feat/squashed-bottom"], ["feat/reused", "main"]] as const) {
      await fixtureGit(repo, ["checkout", "--quiet", "-b", branch, base]);
      await fixtureGit(repo, ["-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", branch]);
    }

    await fixtureGit(repo, ["checkout", "--quiet", "main"]);
    await fixtureGit(origin, ["fetch", "--quiet", repo, "+refs/heads/*:refs/heads/*"]);
    await fixtureGit(repo, ["fetch", "--quiet", "origin"]);

    const rows = [
      row("100", "merged", "REVIEW", "-", "feat/merged"),
      row("101", "open", "REVIEW", "-", "feat/open"),
      row("102", "child", "REVIEW", "101", "feat/child"),
      row("103", "other", "REVIEW", "-", "feat/other"),
      row("104", "unstarted", "TODO", "-", "-"),
      row("105", "closed", "REVIEW", "-", "feat/closed"),
      row("106", "no-pr", "REVIEW", "-", "feat/nopr"),
      row("107", "dropped", "DROPPED", "-", "-"),
      row("108", "into-layer", "REVIEW", "-", "feat/into-layer"),
      row("109", "rebased", "REVIEW", "-", "feat/rebased"),
      row("110", "after-merged", "TODO", "100,107", "-"),
      row("111", "after-open", "TODO", "101", "-"),
      row("112", "after-child", "TODO", "101,102", "-"),
      row("113", "two-chains", "TODO", "101,103", "-"),
      row("114", "after-unstarted", "TODO", "104", "-"),
      row("115", "after-closed", "TODO", "105", "-"),
      row("116", "after-no-pr", "TODO", "106", "-"),
      row("117", "cut-me", "TODO", "101", "-"),
      row("118", "unblocked", "TODO", "-", "-"),
      row("119", "merged-and-stale", "TODO", "100,101", "-"),
      row("121", "merged-and-rebased", "TODO", "100,109", "-"),
      row("122", "after-layer-merge", "TODO", "108", "-"),
      row("123", "already-open", "REVIEW", "-", "feat/already-open"),
      row("124", "reused", "REVIEW", "-", "feat/reused"),
      row("125", "after-reused", "TODO", "124", "-"),
      row("126", "squashed-bottom", "REVIEW", "-", "feat/squashed-bottom"),
      row("127", "on-squashed", "REVIEW", "126", "feat/on-squashed"),
      row("128", "after-squash-stack", "TODO", "126,127", "-"),
      row("129", "after-layer-and-parent", "TODO", "101,102,108", "-"),
      row("132", "linked", "TODO", "-", "-"),
    ];

    await writeFixture(temporary, "plans/fixture/index.tsv", `${[header, ...rows].join("\n")}\n`);

    const childOid = (await fixtureGit(repo, ["rev-parse", "feat/child"])).trimEnd();
    for (const [branch, output] of [
      ["feat/merged", `MERGED ${mergeOid}`],
      ["feat/into-layer", `MERGED ${childOid}`],
      ["feat/open", "OPEN -"],
      ["feat/child", "OPEN -"],
      ["feat/other", "OPEN -"],
      ["feat/rebased", "OPEN -"],
      ["feat/closed", "CLOSED -"],
      ["feat/reused", `MERGED ${mergeOid}\nOPEN -`],
      ["feat/squashed-bottom", `MERGED ${mergeOid}`],
      ["feat/nopr", ""],
      ["feat/on-squashed", "OPEN -"],
    ] as const)
      await fixture(blockerArgs(branch), output);
  });

  test.each([
    ["110", "merged and dropped blockers select trunk", "origin/main"],
    ["111", "an open blocker selects its branch", "feat/open"],
    ["112", "a parent and child select the child", "feat/child"],
    ["118", "an unblocked row selects trunk", "origin/main"],
    ["121", "a rebased branch contains the squash merge", "feat/rebased"],
    ["125", "OPEN takes priority over MERGED on a reused branch", "feat/reused"],
    ["128", "a stack contains its squashed bottom branch", "feat/on-squashed"],
    ["129", "a merge into a layer selects the child", "feat/child"],
  ])("test-stack-base %s: %s", async (id, _name, base) => {
    const result = await stackBase(id);
    expect([result.code, result.stdout, result.stderr]).toEqual([0, `${base}\n`, ""]);
    if (id === "110") expect(await readFile(log, "utf8")).toContain("--head feat/merged");
  });

  test.each([
    ["113", "unrelated blockers refuse two chains", "two chains"],
    ["114", "an unstarted blocker refuses without a branch", "no branch"],
    ["115", "a closed PR refuses", "closed without merging"],
    ["116", "a blocker without a PR refuses", "no PR"],
    ["119", "a stale branch does not contain the squash merge", "feat/open does not contain it"],
    ["122", "a merge into a layer is not yet on trunk", "merged, but not yet into origin/main"],
    ["123", "a REVIEW row has nothing to start", "nothing to start"],
  ])("test-stack-base %s: %s", async (id, _name, reason) => {
    await refuseBase(id, reason);
  });

  test("test-stack-base gh-not-found: refuses with the fake absent from PATH", async () => {
    await withoutGh();
    await refuseBase("111", "gh not found");
    expect(await calls()).toEqual([]);
  });

  test("test-stack-base no-branch-before-gh: refuses an unstarted blocker before looking up gh", async () => {
    await withoutGh();
    await refuseBase("114", "no branch");
    expect(await calls()).toEqual([]);
  });

  test("test-stack-base dirty: refuses an untracked file", async () => {
    await writeFixture(repo, "dirt");
    await refuseBase("118", "dirty");
  });

  test("test-stack-base unrelated-DOING: another checkout is silent", async () => {
    await doingRows();
    const result = await stackBase("111");
    expect([result.code, result.stdout, result.stderr]).toEqual([0, "feat/open\n", ""]);
  });

  test("test-stack-base DOING-blocker: prs refuses blocker 130", async () => {
    await doingRows();
    await refuseBase("131", "blocker 130 is DOING");
  });

  test("test-stack-base prs-held: refuses row 120 on the current branch", async () => {
    await doingRows();
    await fixtureGit(repo, ["checkout", "--quiet", "-b", "feat/busy", "main"]);
    await refuseBase("111", "row 120 is DOING on feat/busy");
  });

  test("test-stack-base hands-off-held: warns about row 120 and selects the base", async () => {
    await doingRows();
    await fixtureGit(repo, ["checkout", "--quiet", "-b", "feat/busy", "main"]);
    await writeFile(env.SKILLS_CONF ?? "", "DELIVERY=hands-off\n");

    const result = await stackBase("111");
    expect([result.code, result.stdout, result.stderr]).toEqual([
      0, "feat/open\n", "stack-base: warning, row 120 is DOING on feat/busy, this checkout is its thread\n",
    ]);
  });

  test("test-stack-base hands-off-blocker: warns then checks the DOING blocker's PR", async () => {
    await doingRows();
    await fixtureGit(repo, ["branch", "feat/held", "main"]);
    await fixture(blockerArgs("feat/held"), "OPEN -");
    await writeFile(env.SKILLS_CONF ?? "", "DELIVERY=hands-off\n");

    const result = await stackBase("131");
    expect([result.code, result.stdout, result.stderr]).toEqual([
      0, "feat/held\n", "stack-base: warning, blocker 130 is DOING, wait until it is in REVIEW\n",
    ]);

    expect(await calls()).toEqual([blockerArgs("feat/held").join(" ")]);
  });

  test("test-stack-base cut: checks out feat/cut-me and records feat/open", async () => {
    const result = await stackBase("117", true);
    expect([result.code, result.stdout, result.stderr]).toEqual([0, "feat/open\n", ""]);

    expect(await fixtureGit(repo, ["branch", "--show-current"])).toBe("feat/cut-me\n");
    expect(await fixtureGit(repo, ["config", "branch.feat/cut-me.skills-base"])).toBe("feat/open\n");
  });

  test("test-stack-base trunk-cut: records origin/main without tracking it", async () => {
    const result = await stackBase("118", true);
    expect([result.code, result.stdout, result.stderr]).toEqual([0, "origin/main\n", ""]);

    expect(await fixtureGit(repo, ["config", "branch.feat/unblocked.skills-base"])).toBe("origin/main\n");
    const tracking = await runCommand(["git", "config", "branch.feat/unblocked.merge"], { cwd: repo, env });
    expect([tracking.code, tracking.stdout, tracking.stderr]).toEqual([1, "", ""]);
  });

  test("test-stack-base already-exists: refuses a previously cut branch", async () => {
    const result = await stackBase("117", true);
    expect([result.code, result.stdout, result.stderr]).toEqual([0, "feat/open\n", ""]);
    await refuseBase("117", "already exists");
  });

  test("test-stack-base linked: accepts the project's linked checkout", async () => {
    const linked = join(temporary, "t3code-0000");
    await fixtureGit(repo, ["worktree", "add", "--quiet", "-b", "linked", linked, "main"]);

    const result = await stackBase("132", false, linked);
    expect([result.code, result.stdout, result.stderr]).toEqual([0, "origin/main\n", ""]);
  });

  test("test-stack-base wrong-checkout: leaves branches, skills-base config and gh calls unchanged", async () => {
    const base = await stackBase("111");
    expect([base.code, base.stdout, base.stderr]).toEqual([0, "feat/open\n", ""]);

    const other = join(temporary, "other");
    await fixtureGit(temporary, ["init", "--quiet", "-b", "main", other]);
    await commitFixture(other);
    await fixtureGit(other, ["config", "branch.feat/scratch.skills-base", "origin/main"]);
    await fixtureGit(other, ["branch", "feat/scratch"]);

    const branches = await fixtureGit(other, ["branch", "--list"]);
    const config = await fixtureGit(other, ["config", "--get-regexp", "skills-base"]);
    const ghLog = await readFile(log, "utf8");

    const result = await stackBase("118", true, other);
    expect([result.code, result.stdout]).toEqual([1, ""]);
    expect(result.stderr).toContain("other");
    expect(result.stderr).toContain("fixture");

    expect(await fixtureGit(other, ["branch", "--list"])).toBe(branches);
    expect(await fixtureGit(other, ["config", "--get-regexp", "skills-base"])).toBe(config);
    expect(await readFile(log, "utf8")).toBe(ghLog);
  });
});

test("review thread QUERY preserves cursor pagination", () => {
  expect(QUERY).toBe("query($owner: String!, $repo: String!, $number: Int!, $after: String) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewThreads(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { isResolved comments(first: 1) { nodes { url author { login } } } } } } } }");
});

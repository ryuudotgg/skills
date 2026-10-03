import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFile, copyFile, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeFixture } from "../test/fixtures.ts";
import {
  faultGit,
  stackCase,
  stackRepo,
  type StackCase,
  type StackVerb,
} from "../test/stack-fixture.ts";
import { declarationText } from "../round/fixtures.ts";
import { appendGhLog, ghFixture } from "../evals/gh-fake.ts";
import { belowVerb, checkBelow, QUERY, stackBaseVerb, startVerb } from "./stack-verbs.ts";

setDefaultTimeout(60_000);

const bin = resolve(import.meta.dir, "../../skills/playbook/bin/skills");
const sourceSkills = resolve(import.meta.dir, "../../skills");
const belowUsage = "skills plans below <Project> <base>";
const stackBaseUsage = "skills plans stack-base [--cut] <Project> <id>";
const header = "id\tslug\tstatus\tpri\teffort\tblocked_by\tctx\tbranch\tupdated\tnote";

type Thread = {
  isResolved: boolean;
  comments: { nodes: { url: string; author: { login: string } | null }[] };
};

function thread(number: number, isResolved: boolean, login: string | null): Thread {
  return {
    isResolved,
    comments: {
      nodes: [
        {
          url: `https://github.com/o/r/pull/1#discussion_r${number}`,
          author: login === null ? null : { login },
        },
      ],
    },
  };
}

function page(
  nodes: readonly Thread[],
  pageInfo?: { hasNextPage: boolean; endCursor: string | null },
): string {
  return JSON.stringify({
    data: {
      repository: { pullRequest: { reviewThreads: { nodes, ...(pageInfo ? { pageInfo } : {}) } } },
    },
  });
}

function prArgs(branch: string): string[] {
  return [
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "all",
    "--json",
    "number,state",
    "--jq",
    '.[] | "\\(.state) \\(.number)"',
  ];
}

function threadArgs(number: string, cursor?: string): string[] {
  return [
    "api",
    "graphql",
    "-F",
    "owner={owner}",
    "-F",
    "repo={repo}",
    "-F",
    `number=${number}`,
    ...(cursor ? ["-f", `after=${cursor}`] : []),
    "-F",
    `query=${QUERY}`,
  ];
}

function row(id: string, slug: string, status: string, blockedBy: string, branch: string): string {
  return [id, slug, status, "P1", "S", blockedBy, "-", branch, "2026-09-26", "-"].join("\t");
}

function blockerArgs(branch: string): string[] {
  return [
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "all",
    "--json",
    "state,mergeCommit",
    "--jq",
    '.[] | [.state, .mergeCommit.oid // "-"] | join(" ")',
  ];
}

async function verbCase(testCase: StackCase) {
  const { temporary, env } = testCase;
  const root = join(temporary, "skills");
  const fixtures = env.GH_STUB_DIR!;
  const log = env.GH_STUB_LOG!;

  env.GIT_AUTHOR_NAME = "skills test";
  env.GIT_COMMITTER_NAME = "skills test";

  await mkdir(join(root, "greptile"), { recursive: true });
  await copyFile(
    join(sourceSkills, "greptile/reviewer.conf"),
    join(root, "greptile/reviewer.conf"),
  );

  async function fixture(
    args: readonly string[],
    output: string,
    code = 0,
    prefix = false,
  ): Promise<void> {
    const key = args.join(" ").replace(/[^A-Za-z0-9._-]/gu, "_");
    const path = join(fixtures, `${key}${prefix ? ".prefix" : ""}`);
    await writeFile(path, output);
    await writeFile(`${path}.exit`, `${code}\n`);
  }

  async function threads(number: string, output: string, code = 0, cursor?: string): Promise<void> {
    await fixture(threadArgs(number, cursor).slice(0, -1), output, code, true);
  }

  async function calls(): Promise<string[]> {
    return (await readFile(log, "utf8")).trimEnd().split("\n").filter(Boolean);
  }

  async function rawGit(cwd: string, args: readonly string[]): Promise<string> {
    const result = await testCase.command(["git", ...args], cwd);
    expect(result.code, result.stderr).toBe(0);
    return result.stdout;
  }

  return { temporary, env, root, fixtures, log, fixture, threads, calls, rawGit };
}

async function belowCase(testCase: StackCase) {
  const common = await verbCase(testCase);
  const { root, fixtures, log } = common;
  const repository = await stackRepo(testCase, {
    name: "fixture",
    mode: "init",
    publish: "fetch",
    commits: [
      { branch: "main", message: "fixture", files: { base: "base\n" } },
      {
        branch: "feat/a",
        from: "main",
        base: "origin/main",
        message: "fixture",
        files: { a: "a\n" },
      },
      { branch: "feat/b", from: "feat/a", base: "feat/a", message: "fixture", files: { b: "b\n" } },
    ],
    checkout: "main",
    index: {
      project: "fixture",
      text: `${header}\n1\ta\tREVIEW\tP1\tS\t-\t-\tfeat/a\t2026-09-26\t-\n2\tb\tREVIEW\tP1\tS\t1\t-\tfeat/b\t2026-09-26\t-\n3\tnew\tTODO\tP1\tS\t2\t-\t-\t2026-09-26\t-\n`,
    },
  });

  const { repo, origin, run, command } = repository;

  await testCase.executable(
    join(origin, "hooks/post-receive"),
    '#!/bin/sh\nwhile read -r old new refname; do\n  printf "push %s\\n" "$refname" >> "$GH_STUB_LOG"\ndone\n',
  );

  const preflight: StackVerb = (args, io) =>
    checkBelow("fixture", args[0]!, root, io, async (args) => {
      appendGhLog(log, args);

      const result = ghFixture(fixtures, args);
      io.err(result.stderr.toString());

      return result.code === 0 ? result.stdout.toString() : undefined;
    });

  const registeredBelow: StackVerb = (args, io) => belowVerb(args, belowUsage, root, io);

  async function below(base = "feat/b", cwd = repo) {
    const { code, stdout, stderr } = await run(preflight, [base], cwd);
    return { code, stdout, stderr };
  }

  async function refusal(base: string, reason: string): Promise<void> {
    const result = await below(base);
    expect([result.code, result.stdout, result.stderr]).toEqual([1, "", `below: ${reason}\n`]);
  }

  return { ...common, repo, repository, command, run, registeredBelow, below, refusal };
}

async function baseCase(testCase: StackCase) {
  const common = await verbCase(testCase);
  const { temporary, env, root, fixture } = common;
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

  const repository = await stackRepo(testCase, {
    name: "fixture",
    mode: "init",
    publish: "fetch",
    commits: [
      { branch: "main", message: "fixture" },
      { branch: "feat/open", from: "main", message: "feat/open" },
      { branch: "feat/child", from: "feat/open", message: "feat/child" },
      { branch: "feat/other", from: "main", message: "feat/other" },
      { branch: "main", message: "squash of feat/merged" },
      { branch: "feat/rebased", from: "main", message: "feat/rebased" },
      { branch: "feat/squashed-bottom", from: "main", message: "feat/squashed-bottom" },
      { branch: "feat/on-squashed", from: "feat/squashed-bottom", message: "feat/on-squashed" },
      { branch: "feat/reused", from: "main", message: "feat/reused" },
    ],
    checkout: "main",
    index: { project: "fixture", text: `${[header, ...rows].join("\n")}\n` },
  });

  const { repo, command, run } = repository;
  const mergeOid = repository.tips.main!;
  const childOid = repository.tips["feat/child"]!;
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

  const verb: StackVerb = (args, io) => stackBaseVerb(args, stackBaseUsage, root, io);
  async function stackBase(id: string, cut = false, cwd = repo) {
    return run(verb, [...(cut ? ["--cut"] : []), "fixture", id], cwd);
  }

  async function refuseBase(id: string, reason: string): Promise<void> {
    const result = await stackBase(id);
    expect([result.code, result.stdout]).toEqual([1, ""]);
    expect(result.stderr).toContain(reason);
  }

  async function doingRows(): Promise<void> {
    await appendFile(
      join(temporary, "plans/fixture/index.tsv"),
      `${[
        row("120", "busy", "DOING", "-", "feat/busy"),
        row("130", "held", "DOING", "-", "feat/held"),
        row("131", "after-held", "TODO", "130", "-"),
      ].join("\n")}\n`,
    );
  }

  async function withoutGh(): Promise<void> {
    const path = join(temporary, "nogh");
    await mkdir(path);

    for (const tool of [
      "sh",
      "git",
      "awk",
      "sed",
      "cut",
      "tr",
      "dirname",
      "basename",
      "cat",
      "bun",
    ]) {
      const executable = Bun.which(tool);
      if (!executable) throw new Error(`fixture tool not found: ${tool}`);
      await symlink(executable, join(path, tool));
    }

    env.PATH = path;
    expect(Bun.which("gh", { PATH: env.PATH })).toBeNull();
  }

  return { ...common, repo, repository, command, stackBase, refuseBase, doingRows, withoutGh };
}

describe("plans below", () => {
  test.concurrent("start and stack-base refuse a BLOCKED layer before gh or cutting a branch", async () => {
    const testCase = await stackCase("skills-blocked-layer-", { assertNoGhCalls: true });
    try {
      const { repo, root, calls, command } = await baseCase(testCase);
      await appendFile(
        join(testCase.temporary, "plans/fixture/index.tsv"),
        `${[
          row("130", "red-layer", "BLOCKED", "-", "feat/red").replace(/-$/, "#1 failing Test -"),
          row("131", "after-red", "TODO", "101,130", "-"),
        ].join("\n")}\n`,
      );

      const before = await command(["git", "for-each-ref", "refs/heads/"]);

      for (const cut of [false, true]) {
        const result = await testCase.run(
          (args, io) => stackBaseVerb(args, stackBaseUsage, root, io),
          [...(cut ? ["--cut"] : []), "fixture", "131"],
          repo,
        );

        expect(result.code).toBe(1);
        expect(result.stderr).toContain("blocker 130 is BLOCKED: #1 failing Test -");
      }

      const started = await testCase.run(
        (args, io) => startVerb(args, "skills plans start <Project> <id>", root, io),
        ["fixture", "131"],
        repo,
      );

      expect(started.code).toBe(1);
      expect(started.stderr).toContain("blocker 130 is BLOCKED: #1 failing Test -");
      expect(await calls()).toEqual([]);
      expect(await command(["git", "for-each-ref", "refs/heads/"])).toEqual(before);
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("refuses a failed middle base read before reading any PR threads", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { fixture, threads, calls, below } = await belowCase(testCase);
      await fixture(prArgs("feat/a"), "OPEN 1");
      await fixture(prArgs("feat/b"), "OPEN 2");

      await threads("1", page([]));
      await threads("2", page([]));
      await faultGit(testCase);
      testCase.env.FAULT_PATTERN = "config --get branch.feat/a.skills-base";

      const result = await below("feat/b");
      expect([result.code, result.stdout]).toEqual([1, ""]);
      expect(result.stderr).toContain("cannot read the base chain of feat/b");
      expect(result.stderr).toContain("branch.feat/a.skills-base");
      expect(await calls()).toEqual([]);
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("refuses a recorded base cycle before reading any PR threads", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { repository, calls, below } = await belowCase(testCase);

      await repository.git(["config", "branch.feat/a.skills-base", "feat/b"]);

      const result = await below("feat/b");
      expect([result.code, result.stdout]).toEqual([1, ""]);
      expect(result.stderr).toBe(
        "below: cannot read the base chain of feat/b: cycle in recorded bases at feat/b\n",
      );

      expect(await calls()).toEqual([]);
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("start refuses a failed resumable base read", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { root, repository, calls } = await belowCase(testCase);

      await repository.branch("feat/new", "feat/b", "feat/b");
      await repository.git(["checkout", "--quiet", "feat/new"]);

      const before = await readFile(repository.index!, "utf8");
      await faultGit(testCase);
      testCase.env.FAULT_PATTERN = "config --get branch.feat/new.skills-base";
      const start: StackVerb = (args, io) => startVerb(args, "plans start", root, io);

      const result = await repository.run(start, ["fixture", "3"]);
      expect([result.code, result.stdout]).toEqual([1, ""]);
      expect(result.stderr).toContain("start: cannot read branch.feat/new.skills-base");
      expect(await readFile(repository.index!, "utf8")).toBe(before);
      expect(await calls()).toEqual([]);
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-preflight resolved: accepts resolved layers without checks or writes", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { repo, log, fixture, threads, calls, rawGit, below } = await belowCase(testCase);
      await fixture(prArgs("feat/a"), "OPEN 1");
      await fixture(prArgs("feat/b"), "OPEN 2");
      await threads("1", page([]));
      await threads("2", page([]));

      const result = await below();
      expect([result.code, result.stdout, result.stderr]).toEqual([0, "", ""]);
      expect(await calls()).toEqual(
        [prArgs("feat/a"), threadArgs("1"), prArgs("feat/b"), threadArgs("2")].map((args) =>
          args.join(" "),
        ),
      );

      expect(await readFile(log, "utf8")).not.toContain("pr checks");
      expect(await readFile(log, "utf8")).not.toContain("pulls/");
      expect(await rawGit(repo, ["for-each-ref", "refs/heads/feat/new"])).toBe("");
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-preflight unresolved: names the thread and never pushes", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { fixture, threads, calls, below } = await belowCase(testCase);
      await fixture(prArgs("feat/a"), "OPEN 1");
      await fixture(prArgs("feat/b"), "OPEN 2");
      await threads("1", page([thread(11, false, "greptile-apps")]));
      await threads("2", page([]));

      const result = await below();
      expect([result.code, result.stdout, result.stderr]).toEqual([
        1,
        "",
        "open\t1\tfeat/a\t1\thttps://github.com/o/r/pull/1#discussion_r11\nbelow: unresolved Greptile threads below the base\n",
      ]);

      expect((await calls()).filter((call) => call.startsWith("push "))).toEqual([]);
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-reviewers: unresolved Greptile or TestBot or ThirdBot threads below the base", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { env, root, fixture, threads, calls, below } = await belowCase(testCase);
      for (const name of ["testbot", "thirdbot"]) {
        await mkdir(join(root, name));
        await writeFile(join(root, name, "reviewer.conf"), declarationText(name));
        await writeFile(
          join(root, name, "SKILL.md"),
          `---\nname: ${name}\ndescription: Reviewer extension.\noptional: true\nrequires: prs\n---\n`,
        );
      }

      await writeFile(env.SKILLS_CONF!, "DELIVERY=prs\nWITH=greptile testbot\n");
      await fixture(prArgs("feat/a"), "OPEN 1\n");
      const nodes = [
        thread(60, false, "testbot"),
        thread(61, false, "developer"),
        thread(62, false, "thirdbot-fan"),
        thread(63, true, "testbot"),
      ].map((entry, index) => ({
        ...entry,
        id: `B${index + 1}`,
        comments: {
          nodes: [
            {
              ...entry.comments.nodes[0]!,
              url: `https://github.com/owner/repo/pull/18#discussion_r${60 + index}`,
            },
          ],
        },
      }));

      await threads("1", page(nodes));

      const result = await below("feat/a");
      expect(result).toEqual({
        code: 1,
        stdout: "",
        stderr:
          "open\t1\tfeat/a\t1\thttps://github.com/owner/repo/pull/18#discussion_r60\nbelow: unresolved Greptile or TestBot or ThirdBot threads below the base\n",
      });

      expect(await calls()).toEqual(
        [prArgs("feat/a"), threadArgs("1")].map((args) => args.join(" ")),
      );
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("installed Greptile and CodeRabbit refuse their open threads regardless of delivery", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { env, root, fixture, threads, below } = await belowCase(testCase);
      for (const name of ["greptile", "coderabbit"]) {
        await mkdir(join(root, name), { recursive: true });

        for (const file of ["reviewer.conf", "SKILL.md"])
          await copyFile(join(sourceSkills, name, file), join(root, name, file));
      }

      await writeFile(env.SKILLS_CONF!, "DELIVERY=hands-off\n");
      await fixture(prArgs("feat/a"), "OPEN 1\n");

      for (const login of ["GREPTILE-APPS", "coderabbitai[bot]"]) {
        await threads(
          "1",
          page([thread(60, false, login), thread(61, false, "developer"), thread(62, true, login)]),
        );

        const result = await below("feat/a");
        expect(result).toEqual({
          code: 1,
          stdout: "",
          stderr:
            "open\t1\tfeat/a\t1\thttps://github.com/o/r/pull/1#discussion_r60\nbelow: unresolved CodeRabbit or Greptile threads below the base\n",
        });
      }
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-preflight trunk: reads no PRs and prints nothing", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { calls, below } = await belowCase(testCase);
      const before = await calls();
      const result = await below("origin/main");

      expect([result.code, result.stdout, result.stderr]).toEqual([0, "", ""]);
      expect(await calls()).toEqual(before);
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-preflight merged: skips the merged layer's threads", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { log, fixture, threads, calls, below } = await belowCase(testCase);
      await fixture(prArgs("feat/a"), "MERGED 5");
      await fixture(prArgs("feat/b"), "OPEN 2");
      await threads("2", page([]));

      const result = await below();
      expect([result.code, result.stdout, result.stderr]).toEqual([0, "", ""]);
      expect(await readFile(log, "utf8")).not.toContain("number=5");
      expect(await calls()).toEqual(
        [prArgs("feat/a"), prArgs("feat/b"), threadArgs("2")].map((args) => args.join(" ")),
      );
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-preflight unowned: refuses a branch without an index row", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { calls, refusal } = await belowCase(testCase);
      await refusal("feat/unowned", "feat/unowned is not an owned branch");
      expect(await calls()).toEqual([]);
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-preflight closed: refuses a PR closed without merging", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { fixture, calls, refusal } = await belowCase(testCase);
      await fixture(prArgs("feat/a"), "CLOSED 7");
      await refusal("feat/a", "PR for feat/a was closed without merging");
      expect(await calls()).toEqual([prArgs("feat/a").join(" ")]);
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-preflight empty: refuses a branch without a PR", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { fixture, calls, refusal } = await belowCase(testCase);
      await fixture(prArgs("feat/a"), "");
      await refusal("feat/a", "feat/a has no PR");
      expect(await calls()).toEqual([prArgs("feat/a").join(" ")]);
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-preflight threads-failed: refuses a failed thread read", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { fixture, threads, calls, refusal } = await belowCase(testCase);
      await fixture(prArgs("feat/a"), "OPEN 1");
      await threads("1", "", 1);

      await refusal("feat/a", "gh failed reading review threads for feat/a");
      expect(await calls()).toEqual([prArgs("feat/a").join(" "), threadArgs("1").join(" ")]);
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-preflight wrong checkout: preserves branches, config and the gh log", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { calls, rawGit, below } = await belowCase(testCase);
      const otherRepository = await stackRepo(testCase, {
        name: "other",
        mode: "init",
        remote: false,
        publish: "none",
        commits: [{ branch: "main", message: "fixture" }],
        checkout: "main",
      });

      await otherRepository.branch("feat/scratch", "main", "origin/main");
      const other = otherRepository.repo;

      const branches = await rawGit(other, ["branch", "--list"]);
      const config = await rawGit(other, ["config", "--get-regexp", "skills-base"]);
      const before = await calls();

      const result = await below("feat/b", other);
      expect([result.code, result.stdout, result.stderr]).toEqual([
        1,
        "",
        "below: this checkout is other, not a checkout of fixture\n",
      ]);

      expect(await rawGit(other, ["branch", "--list"])).toBe(branches);
      expect(await rawGit(other, ["config", "--get-regexp", "skills-base"])).toBe(config);
      expect(await calls()).toEqual(before);
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("150 threads: finds only reviewer thread 120 on the second page", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { fixture, threads, calls, below } = await belowCase(testCase);
      await fixture(prArgs("feat/a"), "OPEN 1");

      const first = Array.from({ length: 100 }, (_, offset) =>
        thread(offset + 1, offset % 2 === 0, offset % 2 === 0 ? "greptile-apps" : "developer"),
      );

      const second = Array.from({ length: 50 }, (_, offset) =>
        thread(offset + 101, offset !== 19, "GREPTILE-APPS[bot]"),
      );

      await threads("1", page(first, { hasNextPage: true, endCursor: "cursor100" }));
      await threads("1", page(second, { hasNextPage: false, endCursor: null }), 0, "cursor100");

      const result = await below("feat/a");
      expect([result.code, result.stdout, result.stderr]).toEqual([
        1,
        "",
        "open\t1\tfeat/a\t1\thttps://github.com/o/r/pull/1#discussion_r120\nbelow: unresolved Greptile threads below the base\n",
      ]);

      expect(await calls()).toEqual(
        [prArgs("feat/a"), threadArgs("1"), threadArgs("1", "cursor100")].map((args) =>
          args.join(" "),
        ),
      );

      expect((await calls())[2]).toContain("-f after=cursor100 -F query=");
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent.each([
    ["unparsable JSON", "not json"],
    [
      "errors key",
      '{"errors":[],"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}',
    ],
    ["null pullRequest", '{"data":{"repository":{"pullRequest":null}}}'],
    ["null reviewThreads", '{"data":{"repository":{"pullRequest":{"reviewThreads":null}}}}'],
    ["missing nodes", '{"data":{"repository":{"pullRequest":{"reviewThreads":{}}}}}'],
    ["nonarray nodes", '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":{}}}}}}'],
    ["empty cursor", page([], { hasNextPage: true, endCursor: "" })],
    ["null cursor", page([], { hasNextPage: true, endCursor: null })],
    [
      "nonstring cursor",
      '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[],"pageInfo":{"hasNextPage":true,"endCursor":7}}}}}}',
    ],
  ])("refuses %s at the thread JSON boundary", async (_name, output) => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { fixture, threads, refusal } = await belowCase(testCase);
      await fixture(prArgs("feat/a"), "OPEN 1");
      await threads("1", output);
      await refusal("feat/a", "gh failed reading review threads for feat/a");
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("buffers open lines until every layer succeeds", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { fixture, threads, refusal } = await belowCase(testCase);
      await fixture(prArgs("feat/a"), "OPEN 1");
      await fixture(prArgs("feat/b"), "CLOSED 2");
      await threads("1", page([thread(11, false, "greptile-apps")]));

      await refusal("feat/b", "PR for feat/b was closed without merging");
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("reads the first OPEN PR even after MERGED and CLOSED PRs", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { fixture, threads, calls, below } = await belowCase(testCase);
      await fixture(prArgs("feat/a"), "MERGED 5\nCLOSED 6\nOPEN 1\nOPEN 2");
      await threads("1", page([]));

      const result = await below("feat/a");
      expect([result.code, result.stdout, result.stderr]).toEqual([0, "", ""]);
      expect(await calls()).toEqual(
        [prArgs("feat/a"), threadArgs("1")].map((args) => args.join(" ")),
      );
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-reviewers: missing reviewers checks PR state without querying threads", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { root, fixture, calls, below, refusal } = await belowCase(testCase);
      await rm(join(root, "greptile/reviewer.conf"));
      await fixture(prArgs("feat/a"), "OPEN 1");

      const result = await below("feat/a");
      expect([result.code, result.stdout, result.stderr]).toEqual([0, "", ""]);
      expect(await calls()).toEqual([prArgs("feat/a").join(" ")]);

      await fixture(prArgs("feat/a"), "CLOSED 7");
      await refusal("feat/a", "PR for feat/a was closed without merging");
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("ignores null authors, human starters and resolved reviewer threads", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { fixture, threads, below } = await belowCase(testCase);
      await fixture(prArgs("feat/a"), "OPEN 1");
      await threads(
        "1",
        page([
          thread(1, false, null),
          thread(2, false, "developer"),
          thread(3, true, "greptile-apps"),
        ]),
      );

      const result = await below("feat/a");
      expect([result.code, result.stdout, result.stderr]).toEqual([0, "", ""]);
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-reviewers: below queried with unreadable declarations", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { root, calls, below } = await belowCase(testCase);
      await mkdir(join(root, "thirdbot"));
      await writeFile(
        join(root, "thirdbot/reviewer.conf"),
        declarationText("thirdbot").replace(/^TRIGGER=.*\n/m, ""),
      );

      const result = await below();
      expect([result.code, result.stdout]).toEqual([1, ""]);
      expect(result.stderr).toContain(
        `reviewers: ${join(root, "thirdbot/reviewer.conf")}: missing TRIGGER\n`,
      );

      expect(result.stderr).toEndWith("below: cannot read reviewer declarations\n");
      expect(await calls()).toEqual([]);
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("refuses a failed PR read", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { fixture, refusal } = await belowCase(testCase);
      await fixture(prArgs("feat/a"), "", 1);
      await refusal("feat/a", "gh pr list failed for feat/a");
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("caps thread pagination at 100 pages without printing buffered lines", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { fixture, threads, calls, refusal } = await belowCase(testCase);
      await fixture(prArgs("feat/a"), "OPEN 1");
      const repeating = page([thread(11, false, "greptile-apps")], {
        hasNextPage: true,
        endCursor: "again",
      });

      await threads("1", repeating);
      await threads("1", repeating, 0, "again");

      await refusal("feat/a", "gh failed reading review threads for feat/a");
      expect((await calls()).filter((call) => call.startsWith("api graphql"))).toHaveLength(100);
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("usage names both registered verbs", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { root } = await verbCase(testCase);
      for (const [verb, usage] of [
        ["below", "skills plans below <Project> <base>"],
        ["stack-base", "skills plans stack-base [--cut] <Project> <id>"],
      ] as const) {
        const result = await testCase.command(
          [bin, "--root", root, "plans", verb],
          testCase.temporary,
        );

        expect([result.code, result.stdout, result.stderr]).toEqual([2, "", `usage: ${usage}\n`]);
      }
    } finally {
      await testCase.dispose();
    }
  });
});

describe("plans stack-base", () => {
  test.concurrent.each([
    ["110", "merged and dropped blockers select trunk", "origin/main"],
    ["111", "an open blocker selects its branch", "feat/open"],
    ["112", "a parent and child select the child", "feat/child"],
    ["118", "an unblocked row selects trunk", "origin/main"],
    ["121", "a rebased branch contains the squash merge", "feat/rebased"],
    ["125", "OPEN takes priority over MERGED on a reused branch", "feat/reused"],
    ["128", "a stack contains its squashed bottom branch", "feat/on-squashed"],
    ["129", "a merge into a layer selects the child", "feat/child"],
  ])("test-stack-base %s: %s", async (id, _name, base) => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { log, stackBase } = await baseCase(testCase);
      const result = await stackBase(id);
      expect([result.code, result.stdout, result.stderr]).toEqual([0, `${base}\n`, ""]);
      if (id === "110") expect(await readFile(log, "utf8")).toContain("--head feat/merged");
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent.each([
    ["113", "unrelated blockers refuse two chains", "two chains"],
    ["114", "an unstarted blocker refuses without a branch", "no branch"],
    ["115", "a closed PR refuses", "closed without merging"],
    ["116", "a blocker without a PR refuses", "no PR"],
    ["119", "a stale branch does not contain the squash merge", "feat/open does not contain it"],
    ["122", "a merge into a layer is not yet on trunk", "merged, but not yet into origin/main"],
    ["123", "a REVIEW row has nothing to start", "nothing to start"],
  ])("test-stack-base %s: %s", async (id, _name, reason) => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { refuseBase } = await baseCase(testCase);
      await refuseBase(id, reason);
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-stack-base gh-not-found: refuses with the fake absent from PATH", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { calls, refuseBase, withoutGh } = await baseCase(testCase);
      await withoutGh();
      await refuseBase("111", "gh not found");
      expect(await calls()).toEqual([]);
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-stack-base no-branch-before-gh: refuses an unstarted blocker before looking up gh", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { calls, refuseBase, withoutGh } = await baseCase(testCase);
      await withoutGh();
      await refuseBase("114", "no branch");
      expect(await calls()).toEqual([]);
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-stack-base dirty: refuses an untracked file", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { repo, refuseBase } = await baseCase(testCase);
      await writeFixture(repo, "dirt");
      await refuseBase("118", "dirty");
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-stack-base unrelated-DOING: another checkout is silent", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { stackBase, doingRows } = await baseCase(testCase);
      await doingRows();
      const result = await stackBase("111");
      expect([result.code, result.stdout, result.stderr]).toEqual([0, "feat/open\n", ""]);
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-stack-base DOING-blocker: prs refuses blocker 130", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { refuseBase, doingRows } = await baseCase(testCase);
      await doingRows();
      await refuseBase("131", "blocker 130 is DOING");
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-stack-base prs-held: refuses row 120 on the current branch", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { repository, refuseBase, doingRows } = await baseCase(testCase);
      await doingRows();
      await repository.branch("feat/busy", "main");
      await repository.git(["checkout", "--quiet", "feat/busy"]);
      await refuseBase("111", "row 120 is DOING on feat/busy");
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-stack-base hands-off-held: warns about row 120 and selects the base", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { env, repository, stackBase, doingRows } = await baseCase(testCase);
      await doingRows();
      await repository.branch("feat/busy", "main");
      await repository.git(["checkout", "--quiet", "feat/busy"]);
      await writeFile(env.SKILLS_CONF ?? "", "DELIVERY=hands-off\n");

      const result = await stackBase("111");
      expect([result.code, result.stdout, result.stderr]).toEqual([
        0,
        "feat/open\n",
        "stack-base: warning, row 120 is DOING on feat/busy, this checkout is its thread\n",
      ]);
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-stack-base hands-off-blocker: warns then checks the DOING blocker's PR", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { env, fixture, calls, repository, stackBase, doingRows } = await baseCase(testCase);
      await doingRows();
      await repository.branch("feat/held", "main");
      await fixture(blockerArgs("feat/held"), "OPEN -");
      await writeFile(env.SKILLS_CONF ?? "", "DELIVERY=hands-off\n");

      const result = await stackBase("131");
      expect([result.code, result.stdout, result.stderr]).toEqual([
        0,
        "feat/held\n",
        "stack-base: warning, blocker 130 is DOING, wait until it is in REVIEW\n",
      ]);

      expect(await calls()).toEqual([blockerArgs("feat/held").join(" ")]);
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-stack-base cut: checks out feat/cut-me and records feat/open", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { repo, rawGit, stackBase } = await baseCase(testCase);
      const result = await stackBase("117", true);
      expect([result.code, result.stdout, result.stderr]).toEqual([0, "feat/open\n", ""]);

      expect(await rawGit(repo, ["branch", "--show-current"])).toBe("feat/cut-me\n");
      expect(await rawGit(repo, ["config", "branch.feat/cut-me.skills-base"])).toBe("feat/open\n");
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-stack-base trunk-cut: records origin/main without tracking it", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { repo, rawGit, command, stackBase } = await baseCase(testCase);
      const result = await stackBase("118", true);
      expect([result.code, result.stdout, result.stderr]).toEqual([0, "origin/main\n", ""]);

      expect(await rawGit(repo, ["config", "branch.feat/unblocked.skills-base"])).toBe(
        "origin/main\n",
      );

      const tracking = await command(["git", "config", "branch.feat/unblocked.merge"]);
      expect([tracking.code, tracking.stdout, tracking.stderr]).toEqual([1, "", ""]);
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-stack-base already-exists: refuses a previously cut branch", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { stackBase, refuseBase } = await baseCase(testCase);
      const result = await stackBase("117", true);
      expect([result.code, result.stdout, result.stderr]).toEqual([0, "feat/open\n", ""]);
      await refuseBase("117", "already exists");
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-stack-base linked: accepts the project's linked checkout", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { repository, stackBase } = await baseCase(testCase);
      await repository.branch("linked", "main");
      const linked = await repository.holderAt("t3code-0000", "linked");

      const result = await stackBase("132", false, linked);
      expect([result.code, result.stdout, result.stderr]).toEqual([0, "origin/main\n", ""]);
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-stack-base wrong-checkout: leaves branches, skills-base config and gh calls unchanged", async () => {
    const testCase = await stackCase("skills-stack-verbs-");
    try {
      const { log, rawGit, stackBase } = await baseCase(testCase);
      const base = await stackBase("111");
      expect([base.code, base.stdout, base.stderr]).toEqual([0, "feat/open\n", ""]);

      const otherRepository = await stackRepo(testCase, {
        name: "other",
        mode: "init",
        remote: false,
        publish: "none",
        commits: [{ branch: "main", message: "fixture" }],
        checkout: "main",
      });

      await otherRepository.branch("feat/scratch", "main", "origin/main");
      const other = otherRepository.repo;

      const branches = await rawGit(other, ["branch", "--list"]);
      const config = await rawGit(other, ["config", "--get-regexp", "skills-base"]);
      const ghLog = await readFile(log, "utf8");

      const result = await stackBase("118", true, other);
      expect([result.code, result.stdout]).toEqual([1, ""]);
      expect(result.stderr).toContain("other");
      expect(result.stderr).toContain("fixture");

      expect(await rawGit(other, ["branch", "--list"])).toBe(branches);
      expect(await rawGit(other, ["config", "--get-regexp", "skills-base"])).toBe(config);
      expect(await readFile(log, "utf8")).toBe(ghLog);
    } finally {
      await testCase.dispose();
    }
  });
});

test.concurrent("review thread QUERY preserves cursor pagination", async () => {
  expect(QUERY).toBe(
    "query($owner: String!, $repo: String!, $number: Int!, $after: String) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewThreads(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { isResolved comments(first: 1) { nodes { url author { login } } } } } } } }",
  );
});

test.concurrent("below wrapper uses the case environment and refusal exit code", async () => {
  const testCase = await stackCase("skills-stack-verbs-wrapper-");
  try {
    const { root, command, fixture, threads, calls } = await belowCase(testCase);
    await fixture(prArgs("feat/a"), "OPEN 1");
    await threads("1", page([thread(11, false, "greptile-apps")]));

    const result = await command([bin, "--root", root, "plans", "below", "fixture", "feat/a"]);
    expect([result.code, result.stdout, result.stderr]).toEqual([
      1,
      "",
      "open\t1\tfeat/a\t1\thttps://github.com/o/r/pull/1#discussion_r11\nbelow: unresolved Greptile threads below the base\n",
    ]);

    expect(await calls()).toEqual(
      [prArgs("feat/a"), threadArgs("1")].map((args) => args.join(" ")),
    );
  } finally {
    await testCase.dispose();
  }
});

test.concurrent("stack-base wrapper uses the case environment and success exit code", async () => {
  const testCase = await stackCase("skills-stack-verbs-wrapper-");
  try {
    const { root, command, calls } = await baseCase(testCase);
    const result = await command([bin, "--root", root, "plans", "stack-base", "fixture", "111"]);
    expect([result.code, result.stdout, result.stderr]).toEqual([0, "feat/open\n", ""]);
    expect(await calls()).toEqual([blockerArgs("feat/open").join(" ")]);
  } finally {
    await testCase.dispose();
  }
});

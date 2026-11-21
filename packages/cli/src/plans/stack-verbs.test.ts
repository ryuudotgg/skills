import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appendFixture, prList, storedRows, writeFixture } from "../test/fixtures.ts";
import { faultGit, stackCase, stackRepo, type StackVerb } from "../test/stack-fixture.ts";
import {
  baseCase,
  belowCase,
  page,
  row,
  sourceSkills,
  stackBaseUsage,
  thread,
  threadArgs,
} from "../test/stack-verbs-fixture.ts";
import { declarationText } from "../round/fixtures.ts";
import { prListArgs } from "./prs.ts";
import { QUERY, stackBaseVerb, startVerb } from "./stack-verbs.ts";

setDefaultTimeout(60_000);

const restartedPrs = [
  { number: 20, state: "MERGED", ended: "2026-09-20T00:00:00Z" },
  { number: 21, state: "CLOSED", ended: "2026-10-05T00:00:00Z" },
] as const;

function startLog(id: string, branch: string): string {
  return `ts\tproject\tid\tevent\tdetail\n2026-10-01T00:00:00Z\tfixture\t${id}\tstart\t${branch}\n`;
}

describe("plans below", () => {
  test.concurrent("start and stack-base refuse a BLOCKED layer before gh or cutting a branch", async () => {
    const testCase = await stackCase("skills-blocked-layer-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      const { repo, root, calls, command } = await baseCase(testCase);
      await appendFixture(
        testCase.temporary,
        "plans/fixture/index.tsv",
        `${[
          row("130", "red-layer", "BLOCKED", "-", "feat/red").replace(/-$/, "#1 failing Test -"),
          row("131", "after-red", "TODO", "101,130", "-"),
        ].join("\n")}\n`,
        testCase.views,
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
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
    try {
      const { fixture, threads, calls, below } = await belowCase(testCase);
      await fixture(prListArgs("feat/a"), prList([{ number: 1, state: "OPEN" }]));
      await fixture(prListArgs("feat/b"), prList([{ number: 2, state: "OPEN" }]));

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
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
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
    const testCase = await stackCase("skills-stack-verbs-", { views: "kept" });
    try {
      const { root, repository, calls } = await belowCase(testCase);

      await repository.branch("feat/new", "feat/b", "feat/b");
      await repository.git(["checkout", "--quiet", "feat/new"]);

      const before = await storedRows(repository.index!);
      await faultGit(testCase);
      testCase.env.FAULT_PATTERN = "config --get branch.feat/new.skills-base";
      const start: StackVerb = (args, io) => startVerb(args, "plans start", root, io);

      const result = await repository.run(start, ["fixture", "3"]);
      expect([result.code, result.stdout]).toEqual([1, ""]);
      expect(result.stderr).toContain("start: cannot read branch.feat/new.skills-base");
      expect(await storedRows(repository.index!)).toEqual(before);
      expect(await calls()).toEqual([]);
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-preflight resolved: accepts resolved layers without checks or writes", async () => {
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
    try {
      const { repo, log, fixture, threads, calls, rawGit, below } = await belowCase(testCase);
      await fixture(prListArgs("feat/a"), prList([{ number: 1, state: "OPEN" }]));
      await fixture(prListArgs("feat/b"), prList([{ number: 2, state: "OPEN" }]));
      await threads("1", page([]));
      await threads("2", page([]));

      const result = await below();
      expect([result.code, result.stdout, result.stderr]).toEqual([0, "", ""]);
      expect(await calls()).toEqual(
        [prListArgs("feat/a"), threadArgs("1"), prListArgs("feat/b"), threadArgs("2")].map((args) =>
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
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
    try {
      const { fixture, threads, calls, below } = await belowCase(testCase);
      await fixture(prListArgs("feat/a"), prList([{ number: 1, state: "OPEN" }]));
      await fixture(prListArgs("feat/b"), prList([{ number: 2, state: "OPEN" }]));
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
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
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
      await fixture(prListArgs("feat/a"), prList([{ number: 1, state: "OPEN" }]));
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
        [prListArgs("feat/a"), threadArgs("1")].map((args) => args.join(" ")),
      );
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("installed Greptile and CodeRabbit refuse their open threads regardless of delivery", async () => {
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
    try {
      const { env, root, fixture, threads, below } = await belowCase(testCase);
      for (const name of ["greptile", "coderabbit"]) {
        await mkdir(join(root, name), { recursive: true });

        for (const file of ["reviewer.conf", "SKILL.md"])
          await copyFile(join(sourceSkills, name, file), join(root, name, file));
      }

      await writeFile(env.SKILLS_CONF!, "DELIVERY=hands-off\n");
      await fixture(prListArgs("feat/a"), prList([{ number: 1, state: "OPEN" }]));

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
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
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
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
    try {
      const { log, fixture, threads, calls, below } = await belowCase(testCase);
      await fixture(prListArgs("feat/a"), prList([{ number: 5, state: "MERGED" }]));
      await fixture(prListArgs("feat/b"), prList([{ number: 2, state: "OPEN" }]));
      await threads("2", page([]));

      const result = await below();
      expect([result.code, result.stdout, result.stderr]).toEqual([0, "", ""]);
      expect(await readFile(log, "utf8")).not.toContain("number=5");
      expect(await calls()).toEqual(
        [prListArgs("feat/a"), prListArgs("feat/b"), threadArgs("2")].map((args) => args.join(" ")),
      );
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-preflight unowned: refuses a branch without an index row", async () => {
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
    try {
      const { calls, refusal } = await belowCase(testCase);
      await refusal("feat/unowned", "feat/unowned is not an owned branch");
      expect(await calls()).toEqual([]);
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-preflight closed: refuses a PR closed without merging", async () => {
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
    try {
      const { fixture, calls, refusal } = await belowCase(testCase);
      await fixture(prListArgs("feat/a"), prList([{ number: 7, state: "CLOSED" }]));
      await refusal("feat/a", "PR for feat/a was closed without merging");
      expect(await calls()).toEqual([prListArgs("feat/a").join(" ")]);
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-preflight restarted: a PR merged before the row's start does not skip the layer", async () => {
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
    try {
      const { temporary, fixture, calls, refusal } = await belowCase(testCase);
      await writeFixture(temporary, "plans/log.tsv", startLog("1", "feat/a"), testCase.views);
      await fixture(prListArgs("feat/a"), prList(restartedPrs));
      await refusal("feat/a", "PR for feat/a was closed without merging");
      expect(await calls()).toEqual([prListArgs("feat/a").join(" ")]);
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-preflight empty: refuses a branch without a PR", async () => {
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
    try {
      const { fixture, calls, refusal } = await belowCase(testCase);
      await fixture(prListArgs("feat/a"), prList([]));
      await refusal("feat/a", "feat/a has no PR");
      expect(await calls()).toEqual([prListArgs("feat/a").join(" ")]);
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-preflight threads-failed: refuses a failed thread read", async () => {
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
    try {
      const { fixture, threads, calls, refusal } = await belowCase(testCase);
      await fixture(prListArgs("feat/a"), prList([{ number: 1, state: "OPEN" }]));
      await threads("1", "", 1);

      await refusal("feat/a", "gh failed reading review threads for feat/a");
      expect(await calls()).toEqual([prListArgs("feat/a").join(" "), threadArgs("1").join(" ")]);
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-preflight wrong checkout: preserves branches, config and the gh log", async () => {
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
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
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
    try {
      const { fixture, threads, calls, below } = await belowCase(testCase);
      await fixture(prListArgs("feat/a"), prList([{ number: 1, state: "OPEN" }]));

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
        [prListArgs("feat/a"), threadArgs("1"), threadArgs("1", "cursor100")].map((args) =>
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
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
    try {
      const { fixture, threads, refusal } = await belowCase(testCase);
      await fixture(prListArgs("feat/a"), prList([{ number: 1, state: "OPEN" }]));
      await threads("1", output);
      await refusal("feat/a", "gh failed reading review threads for feat/a");
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("buffers open lines until every layer succeeds", async () => {
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
    try {
      const { fixture, threads, refusal } = await belowCase(testCase);
      await fixture(prListArgs("feat/a"), prList([{ number: 1, state: "OPEN" }]));
      await fixture(prListArgs("feat/b"), prList([{ number: 2, state: "CLOSED" }]));
      await threads("1", page([thread(11, false, "greptile-apps")]));

      await refusal("feat/b", "PR for feat/b was closed without merging");
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("reads the first OPEN PR even after MERGED and CLOSED PRs", async () => {
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
    try {
      const { fixture, threads, calls, below } = await belowCase(testCase);
      await fixture(
        prListArgs("feat/a"),
        prList([
          { number: 5, state: "MERGED" },
          { number: 6, state: "CLOSED" },
          { number: 1, state: "OPEN" },
          { number: 2, state: "OPEN" },
        ]),
      );

      await threads("1", page([]));

      const result = await below("feat/a");
      expect([result.code, result.stdout, result.stderr]).toEqual([0, "", ""]);
      expect(await calls()).toEqual(
        [prListArgs("feat/a"), threadArgs("1")].map((args) => args.join(" ")),
      );
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-reviewers: missing reviewers checks PR state without querying threads", async () => {
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
    try {
      const { root, fixture, calls, below, refusal } = await belowCase(testCase);
      await rm(join(root, "greptile/reviewer.conf"));
      await fixture(prListArgs("feat/a"), prList([{ number: 1, state: "OPEN" }]));

      const result = await below("feat/a");
      expect([result.code, result.stdout, result.stderr]).toEqual([0, "", ""]);
      expect(await calls()).toEqual([prListArgs("feat/a").join(" ")]);

      await fixture(prListArgs("feat/a"), prList([{ number: 7, state: "CLOSED" }]));
      await refusal("feat/a", "PR for feat/a was closed without merging");
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("ignores null authors, human starters and resolved reviewer threads", async () => {
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
    try {
      const { fixture, threads, below } = await belowCase(testCase);
      await fixture(prListArgs("feat/a"), prList([{ number: 1, state: "OPEN" }]));
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
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
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

  test.concurrent("does not count a fork PR with the same head name", async () => {
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
    try {
      const { fixture, refusal } = await belowCase(testCase);
      await fixture(prListArgs("feat/a"), prList([{ number: 1, state: "OPEN", fork: true }]));
      await refusal("feat/a", "feat/a has no PR");
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("refuses a failed PR read", async () => {
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
    try {
      const { fixture, refusal } = await belowCase(testCase);
      await fixture(prListArgs("feat/a"), "", 1);
      await refusal("feat/a", "cannot read PRs for feat/a: gh pr list failed");
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("caps thread pagination at 100 pages without printing buffered lines", async () => {
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
    try {
      const { fixture, threads, calls, refusal } = await belowCase(testCase);
      await fixture(prListArgs("feat/a"), prList([{ number: 1, state: "OPEN" }]));
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
    ["134", "a merge into a parent that squash merged into main selects trunk", "origin/main"],
  ])("test-stack-base %s: %s", async (id, _name, base) => {
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
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
    ["136", "a parent whose PRs cannot be read refuses", "cannot read PRs for feat/unread-parent"],
    [
      "138",
      "a parent merge missing from the fetched trunk refuses",
      "merged, but not yet into origin/main",
    ],
  ])("test-stack-base %s: %s", async (id, _name, reason) => {
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
    try {
      const { refuseBase } = await baseCase(testCase);
      await refuseBase(id, reason);
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-stack-base 141: a blocker PR merged before the row's start does not release it", async () => {
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
    try {
      const { temporary, fixture, stackBase } = await baseCase(testCase);
      await appendFixture(
        temporary,
        "plans/fixture/index.tsv",
        `${[
          row("140", "restarted", "REVIEW", "-", "feat/restarted"),
          row("141", "after-restarted", "TODO", "140", "-"),
        ].join("\n")}\n`,
        testCase.views,
      );

      await writeFixture(
        temporary,
        "plans/log.tsv",
        startLog("140", "feat/restarted"),
        testCase.views,
      );

      await fixture(prListArgs("feat/restarted"), prList(restartedPrs));

      const result = await stackBase("141");
      expect([result.code, result.stdout, result.stderr]).toEqual([
        1,
        "",
        "stack-base: blocker 140 PR on feat/restarted was closed without merging\n",
      ]);
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-stack-base gh-not-found: refuses with the fake absent from PATH", async () => {
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
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
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
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
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
    try {
      const { repo, refuseBase } = await baseCase(testCase);
      await writeFixture(repo, "dirt");
      await refuseBase("118", "dirty");
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-stack-base unrelated-DOING: another checkout is silent", async () => {
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
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
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
    try {
      const { refuseBase, doingRows } = await baseCase(testCase);
      await doingRows();
      await refuseBase("131", "blocker 130 is DOING");
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-stack-base prs-held: refuses row 120 on the current branch", async () => {
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
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
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
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
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
    try {
      const { env, fixture, calls, repository, stackBase, doingRows } = await baseCase(testCase);
      await doingRows();
      await repository.branch("feat/held", "main");
      await fixture(prListArgs("feat/held"), prList([{ number: 1, state: "OPEN" }]));
      await writeFile(env.SKILLS_CONF ?? "", "DELIVERY=hands-off\n");

      const result = await stackBase("131");
      expect([result.code, result.stdout, result.stderr]).toEqual([
        0,
        "feat/held\n",
        "stack-base: warning, blocker 130 is DOING, wait until it is in REVIEW\n",
      ]);

      expect(await calls()).toEqual([prListArgs("feat/held").join(" ")]);
    } finally {
      await testCase.dispose();
    }
  });

  test.concurrent("test-stack-base cut: checks out feat/cut-me and records feat/open", async () => {
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
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
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
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
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
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
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
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
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
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

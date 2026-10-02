import { afterAll, expect, test } from "bun:test";
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRepo } from "../test/fixtures.ts";
import { dependencies } from "./round.ts";
import { branchTip, readFixes } from "./fixes.ts";
import { acceptanceCases, failure, fixture, response, success } from "./fixtures.ts";
import { runRound } from "./round.ts";

const temporary: string[] = [];

async function fixtureGit(repo: string, args: readonly string[]): Promise<string> {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });

  if (result.exitCode !== 0) throw new Error(result.stderr.toString());

  return result.stdout.toString();
}

async function commitFixture(repo: string): Promise<void> {
  await fixtureGit(repo, ["add", "-A"]);
  await fixtureGit(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture"]);
}

afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

async function setup() {
  const repo = await createRepo();
  temporary.push(repo);
  writeFileSync(join(repo, "shared"), "base\n");
  writeFileSync(join(repo, "binary"), "\0base\n");
  await commitFixture(repo);

  await fixtureGit(repo, ["checkout", "-q", "-b", "feature"]);
  await fixtureGit(repo, ["config", "branch.feature.skills-base", "main"]);
  appendFileSync(join(repo, "shared"), "feature\n");
  await commitFixture(repo);
  const git = dependencies("", repo, {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  }).git;

  const tip = async () => (await fixtureGit(repo, ["rev-parse", "HEAD"])).trim();
  return { repo, git, tip, reviewed: await tip() };
}

test.concurrent("fix facts: a changed path holding a newline is counted", async () => {
  const value = await setup();
  writeFileSync(join(value.repo, "line\nbreak"), "one\ntwo\n");
  await commitFixture(value.repo);

  expect(await readFixes(value.reviewed, "feature", value.git)).toEqual({
    commits: 1,
    lines: 2,
    added: 1,
    moved: true,
  });
});

test.concurrent("fix facts: equal tip, rebase-only, small fix, new file, thirty lines, binary, repeated addition", async () => {
  const value = await setup();
  let reviewed = value.reviewed;
  const check = async (commits: number, lines: number, added: number, moved: boolean) => {
    expect(await readFixes(reviewed, "feature", value.git)).toEqual({
      commits,
      lines,
      added,
      moved,
    });
  };

  await check(0, 0, 0, false);

  await fixtureGit(value.repo, ["checkout", "-q", "main"]);
  writeFileSync(join(value.repo, "parent"), "parent moved\n");
  await commitFixture(value.repo);

  await fixtureGit(value.repo, ["checkout", "-q", "feature"]);
  await fixtureGit(value.repo, ["rebase", "-q", "main"]);
  await check(0, 0, 0, true);

  appendFileSync(join(value.repo, "shared"), "fix\n");
  await commitFixture(value.repo);
  await check(1, 1, 0, true);

  reviewed = await value.tip();
  writeFileSync(join(value.repo, "new file"), "new\n");
  await commitFixture(value.repo);
  await check(1, 1, 1, true);

  reviewed = await value.tip();
  appendFileSync(join(value.repo, "shared"), "line\n".repeat(30));
  await commitFixture(value.repo);
  await check(1, 30, 0, true);

  reviewed = await value.tip();
  writeFileSync(join(value.repo, "binary"), "\0changed\n");
  await commitFixture(value.repo);
  await check(1, 30, 0, true);

  reviewed = await value.tip();
  writeFileSync(join(value.repo, "repeated"), "first\n");
  await commitFixture(value.repo);
  rmSync(join(value.repo, "repeated"));
  await commitFixture(value.repo);

  writeFileSync(join(value.repo, "repeated"), "second\n");
  await commitFixture(value.repo);
  await check(3, 3, 1, true);
  await fixtureGit(value.repo, ["config", "--unset", "branch.feature.skills-base"]);
  await fixtureGit(value.repo, ["update-ref", "refs/remotes/origin/main", "main"]);
  await fixtureGit(value.repo, [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  ]);

  await check(3, 3, 1, true);
  await fixtureGit(value.repo, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);

  await expect(readFixes(reviewed, "feature", value.git)).rejects.toThrow(
    "cannot resolve origin/HEAD",
  );

  await fixtureGit(value.repo, ["config", "branch.feature.skills-base", "missing-base"]);

  await expect(readFixes(reviewed, "feature", value.git)).rejects.toThrow(
    "cannot resolve origin/HEAD",
  );

  await fixtureGit(value.repo, ["config", "branch.feature.skills-base", "main"]);

  await expect(readFixes("missing-commit", "feature", value.git)).rejects.toThrow(
    "reviewed is not a commit",
  );

  const blob = (await fixtureGit(value.repo, ["rev-parse", "HEAD:shared"])).trim();

  await expect(readFixes(blob, "feature", value.git)).rejects.toThrow("reviewed is not a commit");
  await fixtureGit(value.repo, ["checkout", "-q", "--detach"]);
  await check(3, 3, 1, true);

  for (const branch of ["missing-branch", "origin/main"])
    await expect(readFixes(reviewed, branch, value.git)).rejects.toThrow(
      "branch is not a local branch",
    );
}, 30_000);

test.concurrent("stack parent fix, child rebase, squash parent, deleted parent; fix facts changed checkout; fix facts called gh", async () => {
  const value = await setup();
  await fixtureGit(value.repo, ["checkout", "-q", "main"]);
  await fixtureGit(value.repo, ["update-ref", "refs/remotes/origin/main", "main"]);
  await fixtureGit(value.repo, [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  ]);

  await fixtureGit(value.repo, ["checkout", "-q", "-b", "layer-1"]);
  await fixtureGit(value.repo, ["config", "branch.layer-1.skills-base", "main"]);
  writeFileSync(join(value.repo, "parent"), "parent\n");
  await commitFixture(value.repo);
  const parent = await value.tip();

  await fixtureGit(value.repo, ["checkout", "-q", "-b", "layer-2"]);
  await fixtureGit(value.repo, ["config", "branch.layer-2.skills-base", "layer-1"]);
  writeFileSync(join(value.repo, "child"), "child\n");
  await commitFixture(value.repo);
  const child = await value.tip();

  await fixtureGit(value.repo, ["checkout", "-q", "layer-1"]);
  appendFileSync(join(value.repo, "parent"), "fixed\n");
  await commitFixture(value.repo);
  await fixtureGit(value.repo, ["rebase", "-q", "--onto", "layer-1", parent, "layer-2"]);
  await fixtureGit(value.repo, ["checkout", "-q", "layer-1"]);

  expect(await readFixes(parent, "layer-1", value.git)).toEqual({
    commits: 1,
    lines: 1,
    added: 0,
    moved: true,
  });

  expect(await readFixes(child, "layer-2", value.git)).toEqual({
    commits: 0,
    lines: 0,
    added: 0,
    moved: true,
  });

  expect((await fixtureGit(value.repo, ["branch", "--show-current"])).trim()).toBe("layer-1");

  await fixtureGit(value.repo, ["checkout", "-q", "main"]);
  await fixtureGit(value.repo, ["merge", "-q", "--squash", "layer-1"]);
  await commitFixture(value.repo);
  await fixtureGit(value.repo, ["update-ref", "refs/remotes/origin/main", "main"]);
  await fixtureGit(value.repo, ["rebase", "-q", "--onto", "main", "layer-1", "layer-2"]);

  expect(await readFixes(child, "layer-2", value.git)).toEqual({
    commits: 0,
    lines: 0,
    added: 0,
    moved: true,
  });

  await fixtureGit(value.repo, ["branch", "-q", "-D", "layer-1"]);

  expect(await readFixes(child, "layer-2", value.git)).toEqual({
    commits: 0,
    lines: 0,
    added: 0,
    moved: true,
  });
}, 30_000);

test("batched fix reads use read deadlines, both exclusions, binary and renamed paths", async () => {
  const calls: readonly string[][] = [];
  const recorded = calls as string[][];
  const git = async (args: readonly string[], deadline: number) => {
    expect(deadline).toBe(10_000);
    recorded.push([...args]);

    if (args[0] === "log")
      return success(
        args.includes("--numstat")
          ? "-\t-\tbinary\0\n1\t0\t\0old\0new\0"
          : "new file\0\nnew file\0",
      );

    if (args[0] === "rev-list") return success("first\nsecond\n");
    if (args[0] === "config") return success("main\n");

    return success(args[1] === "--verify" ? "b".repeat(40) : "a".repeat(40));
  };

  expect(await readFixes("a".repeat(40), "feature", git)).toEqual({
    commits: 2,
    lines: 31,
    added: 1,
    moved: true,
  });

  expect(recorded.filter((args) => args[0] === "log")).toHaveLength(2);
  expect(recorded.find((args) => args[0] === "rev-list")).toEqual([
    "rev-list",
    "--cherry-pick",
    "--right-only",
    "--no-merges",
    `${"a".repeat(40)}...${"b".repeat(40)}`,
    `^${"b".repeat(40)}`,
    `^${"b".repeat(40)}`,
  ]);
});

for (const [command, reason] of [
  ["show-ref", "branch is not a local branch"],
  ["rev-list", "cannot read commits"],
  ["log", "cannot read commit changes"],
])
  test(`fix-facts refuses ${reason}`, async () => {
    await expect(
      readFixes("a".repeat(40), "feature", async (args) =>
        args[0] === command ? failure() : success("b".repeat(40)),
      ),
    ).rejects.toThrow(reason);
  });

test("branch tip refuses nonlocal branch", async () => {
  await expect(branchTip("origin/main", async () => failure())).rejects.toThrow(
    "branch is not a local branch",
  );
});

test("auto off: a restack requests no Greptile review, and the first review sits outside the budget", async () => {
  const value = await setup();
  const round = fixture();
  temporary.push(round.temporary);
  round.deps.git = value.git;
  round.deps.env.REVIEW_NOW = "2026-09-28T11:59:00Z";
  round.deps.sleep = async () => {
    throw new Error("decide waited for an automatic review");
  };

  await fixtureGit(value.repo, ["config", "--local", "skills.greptile.auto", "no"]);
  await fixtureGit(value.repo, ["checkout", "-q", "main"]);
  writeFileSync(join(value.repo, "parent"), "parent moved\n");
  await commitFixture(value.repo);
  await fixtureGit(value.repo, ["checkout", "-q", "feature"]);
  await fixtureGit(value.repo, ["rebase", "-q", "main"]);

  const decide = async (triggers: number) => {
    const pr = structuredClone(acceptanceCases.find((entry) => entry.name === "seen-push")!.pr);
    pr.reviews.nodes[0]!.commit = { oid: value.reviewed };
    pr.comments.nodes = Array.from({ length: triggers }, (_, index) => ({
      author: { login: "developer" },
      body: "@greptileai",
      createdAt: `2026-09-28T11:2${index}:00Z`,
    }));

    round.deps.gh = async () => success(response(pr));
    return (await runRound(["decide", "18", "feature", "greptile=fixed"], round.deps)).stdout;
  };

  expect(await decide(1)).toBe("greptile handback rebase-only\nhandback greptile rebase-only\n");

  appendFileSync(join(value.repo, "shared"), "fix\n");
  await commitFixture(value.repo);

  expect(await decide(2)).toBe("greptile rereview below-threshold\nrereview\n");
  expect(await decide(3)).toBe("greptile handback paid-cap\nhandback greptile paid-cap\n");
}, 30_000);

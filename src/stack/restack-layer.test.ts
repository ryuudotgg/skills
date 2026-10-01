import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fixtureGit, writeFixture } from "../test/fixtures.ts";
import { removeTemporary, runCommand, suiteEnvironment, type CommandResult } from "../test/process.ts";

const bin = resolve(import.meta.dir, "../../skills/playbook/bin/skills");
const stubs = resolve(import.meta.dir, "../../scripts/stubs");
let temporary: string;
let origin: string;
let repo: string;
let index: string;
let env: NodeJS.ProcessEnv;

async function git(args: readonly string[], cwd = repo): Promise<string> {
  return (await fixtureGit(cwd, args)).trimEnd();
}

async function command(argv: readonly string[], cwd = repo): Promise<CommandResult> {
  const result = await runCommand(argv, { cwd, env, timeout: 60_000 });
  expect(result.timedOut).toBe(false);
  return result;
}

async function succeed(argv: readonly string[], cwd = repo): Promise<CommandResult> {
  const result = await command(argv, cwd);
  expect(result.code, result.stderr).toBe(0);
  return result;
}

async function commit(branch: string, message: string, files: string[], cwd = repo): Promise<void> {
  await git(["add", "--", ...files], cwd);
  await succeed(["git", "commit", "--quiet", "-m", message], cwd);
  await git(["push", "--quiet", "origin", branch], cwd);
}

async function fresh(name: string): Promise<void> {
  origin = join(temporary, `${name}.git`);
  repo = join(temporary, name, "Proj");
  index = join(temporary, "plans/Proj/index.tsv");

  await mkdir(join(temporary, name), { recursive: true });
  await git(["init", "--quiet", "--bare", "-b", "main", origin], temporary);
  await git(["clone", "--quiet", origin, repo], temporary);
  await git(["config", "commit.gpgsign", "false"]);
  await git(["config", "core.hooksPath", join(repo, ".git/hooks")]);
  await writeFixture(repo, "shared", "base\n");
  await writeFixture(repo, "round", "a\n");
  await commit("main", "chore: initial", ["shared", "round"]);

  for (const [branch, base, file] of [["feat/a", "origin/main", "a"], ["feat/b", "feat/a", "b"], ["feat/c", "feat/b", "c"]] as const) {
    await git(["checkout", "--quiet", "-b", branch]);
    await git(["config", `branch.${branch}.skills-base`, base]);
    await writeFixture(repo, file, `${file}1\n`);
    await commit(branch, `feat: ${file}`, [file]);
  }

  await git(["checkout", "--quiet", "feat/a"]);
  await writeFixture(temporary, "plans/Proj/index.tsv", "id\ta\tb\tc\td\te\tf\tbranch\n1\t-\t-\t-\t-\t-\t-\tfeat/a\n2\t-\t-\t-\t-\t-\t-\tfeat/b\n3\t-\t-\t-\t-\t-\t-\tfeat/c\n");
}

async function holderAt(name: string, branch = "feat/c"): Promise<string> {
  const holder = join(temporary, name);
  await git(["worktree", "add", "--quiet", holder, branch]);
  return realpathSync(holder);
}

async function holderState(holder: string): Promise<{ head: string; tree: string }> {
  return { head: await git(["rev-parse", "HEAD"], holder), tree: await git(["status", "--porcelain"], holder) };
}

async function branches(): Promise<{ local: string; remote: string; tree: string; branch: string }> {
  const refs = ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"];
  return {
    local: await git(refs),
    remote: await git([`--git-dir=${origin}`, ...refs]),
    tree: await git(["status", "--porcelain"]),
    branch: await git(["branch", "--show-current"]),
  };
}

async function tip(branch: string, local: string, remote = local): Promise<void> {
  expect(await git(["rev-parse", branch])).toBe(local);
  expect(await git([`--git-dir=${origin}`, "rev-parse", branch])).toBe(remote);
}

async function executable(path: string, source: string): Promise<void> {
  await writeFixture(temporary, path, source);
  await chmod(join(temporary, path), 0o755);
}

beforeEach(async () => {
  temporary = realpathSync(await mkdtemp(join(tmpdir(), "skills-restack-layer-")));
  env = {
    ...suiteEnvironment(),
    PATH: `${stubs}:${process.env.PATH}`,
    SKILLS_CONF: join(temporary, "skills.conf"),
    PLANS_DIR: join(temporary, "plans"),
    GH_STUB_DIR: join(temporary, "gh"),
    GH_STUB_LOG: join(temporary, "gh.log"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
  };

  delete env.SKILLS_OWN_ROWS;
  await mkdir(join(temporary, "gh"));
  await writeFile(join(temporary, "gh.log"), "");
  await writeFile(join(temporary, "skills.conf"), "DELIVERY=prs\n");
});

describe("restack-layer checkout guards", () => {
  test("wrong checkout", async () => {
    await fresh("wrong-checkout");
    const otherOrigin = join(temporary, "other.git");
    const other = join(temporary, "other");
    await git(["init", "--quiet", "--bare", "-b", "main", otherOrigin], temporary);
    await git(["clone", "--quiet", otherOrigin, other], temporary);
    await git(["commit", "--quiet", "--allow-empty", "-m", "chore: initial"], other);
    await git(["push", "--quiet", "origin", "main"], other);
    await git(["checkout", "--quiet", "-b", "feat/other"], other);
    repo = other;
    origin = otherOrigin;
    const before = await branches();
    const remote = await git(["ls-remote", "origin"]);

    const result = await command([bin, "restack-layer", "-P", "fixture"]);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("restack-layer: this checkout is other, not a checkout of fixture");
    expect(await branches()).toEqual(before);
    expect(await git(["ls-remote", "origin"])).toBe(remote);
  }, 60_000);

  test("matching worktree without index", async () => {
    await fresh("matching-worktree");
    const holder = await holderAt("t3code-0000");
    await rm(index);

    const result = await command([bin, "restack-layer", "-P", "Proj"], holder);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("restack-layer: no index.tsv for Proj");
    expect(result.stderr).not.toContain("not a checkout of");
  }, 60_000);
});

afterEach(async () => {
  try {
    expect(await readFile(join(temporary, "gh.log"), "utf8")).toBe("");
  } finally {
    await removeTemporary(temporary);
  }
});

let oldB: string;
let oldC: string;

async function layer(...args: string[]): Promise<CommandResult> {
  return command([bin, "restack-layer", "-P", "Proj", ...args]);
}

async function layerSuccess(output: string, ...args: string[]): Promise<void> {
  const result = await layer(...args);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe(`${output}\n`);
}

async function refusal(reason: string, ...args: string[]): Promise<CommandResult> {
  const result = await layer(...args);
  expect(result.code, result.stderr).toBe(1);
  expect(result.stderr).toContain(`restack-layer: ${reason}`);
  expect(result.stdout).toBe("");
  return result;
}

async function config(key: string): Promise<string> {
  return (await command(["git", "config", key])).stdout.trimEnd();
}

async function staleB(conflict = false): Promise<void> {
  if (conflict) {
    await git(["checkout", "--quiet", "feat/b"]);
    await writeFixture(repo, "round", "b change\n");
    await commit("feat/b", "feat: b edits round", ["round"]);
  }

  await git(["checkout", "--quiet", "feat/a"]);
  await writeFixture(repo, "round", "a change\n");
  await commit("feat/a", "fix: a edits round", ["round"]);
  oldB = await git(["rev-parse", "feat/b"]);
  oldC = await git(["rev-parse", "feat/c"]);
  await git(["checkout", "--quiet", "feat/b"]);
}

async function unchanged(): Promise<void> {
  await tip("feat/b", oldB);
  await tip("feat/c", oldC);
}

async function conflict(branch = "feat/b", base = "feat/a", lease = oldB, ...args: string[]): Promise<void> {
  await refusal(`conflict rebasing ${branch} onto ${base}, resolve it here, git add, GIT_EDITOR=true git rebase --continue, run the standing checks, then skills restack-layer --push`, ...args);
  const admin = await git(["rev-parse", "--absolute-git-dir"]);
  expect(existsSync(join(admin, "rebase-merge")) || existsSync(join(admin, "rebase-apply"))).toBe(true);
  expect(await config(`branch.${branch}.skills-restack-lease`)).toBe(lease);
}

async function resolveRound(content = "resolved"): Promise<void> {
  await writeFixture(repo, "round", `${content}\n`);
  await git(["add", "--", "round"]);
  await succeed(["git", "rebase", "--continue"]);
}

async function pushed(): Promise<void> {
  const newB = await git(["rev-parse", "feat/b"]);
  const newC = await git(["rev-parse", "feat/c"]);
  expect(newB).not.toBe(oldB);
  expect(newC).not.toBe(oldC);
  await tip("feat/b", newB);
  await tip("feat/c", newC);
  await git(["merge-base", "--is-ancestor", "feat/a", "feat/b"]);
  await git(["merge-base", "--is-ancestor", "feat/b", "feat/c"]);
  expect(await config("branch.feat/b.skills-restack-lease")).toBe("");
}

async function race(name: string, files: string[] = [], message = "fix: raced b"): Promise<string> {
  const racer = join(temporary, name);
  await git(["clone", "--quiet", origin, racer], temporary);
  await git(["checkout", "--quiet", "feat/b"], racer);
  for (const file of files) await writeFixture(racer, file, `${file}\n`);

  if (files.length) await git(["add", "--", ...files], racer);
  await git(["commit", "--quiet", "--allow-empty", "-m", message], racer);
  await git(["push", "--quiet", "origin", "feat/b"], racer);
  return git(["rev-parse", "feat/b"], racer);
}

const movedOrigin = "origin/feat/b moved since the rebase began, nothing pushed; sync feat/b with origin, or drop the restack with git config --unset branch.feat/b.skills-restack-lease";

describe("restack-layer legacy cases", () => {
  test("layer-no-update-refs", async () => {
    await fresh("layer-no-update-refs");
    await staleB();
    await git(["config", "rebase.updateRefs", "true"]);
    await git(["branch", "bystander", "feat/b"]);

    await layerSuccess("rebased feat/b onto feat/a, run the standing checks, then skills restack-layer --push");
    expect(await git(["rev-parse", "bystander"])).toBe(oldB);
    await tip("feat/b", await git(["rev-parse", "feat/b"]), oldB);
    await tip("feat/c", oldC);
  }, 60_000);

  test("layer-ignored-collision", async () => {
    await fresh("layer-ignored-collision");
    await writeFixture(repo, "collision", "parent file\n");
    await commit("feat/a", "feat: add collision", ["collision"]);
    oldB = await git(["rev-parse", "feat/b"]);
    oldC = await git(["rev-parse", "feat/c"]);
    await git(["checkout", "--quiet", "feat/b"]);
    await appendFile(join(repo, ".git/info/exclude"), "collision\n");
    await writeFixture(repo, "collision", "private file\n");

    await refusal("an ignored file in this checkout sits where the rebase adds one");
    await unchanged();
    expect(await readFile(join(repo, "collision"), "utf8")).toBe("private file\n");
    expect(await config("branch.feat/b.skills-restack-lease")).toBe("");
    expect(existsSync(join(repo, ".git/rebase-merge"))).toBe(false);
    expect(existsSync(join(repo, ".git/rebase-apply"))).toBe(false);
  }, 60_000);

  test("ignored collision at the root, run from a subdirectory", async () => {
    await fresh("layer-ignored-collision-subdirectory");
    await writeFixture(repo, "collision", "parent file\n");
    await commit("feat/a", "feat: add collision", ["collision"]);
    oldB = await git(["rev-parse", "feat/b"]);
    oldC = await git(["rev-parse", "feat/c"]);
    await git(["checkout", "--quiet", "feat/b"]);
    await appendFile(join(repo, ".git/info/exclude"), "collision\n");
    await writeFixture(repo, "collision", "private file\n");
    await writeFixture(repo, "sub/tracked", "sub\n");
    await commit("feat/b", "feat: add sub", ["sub/tracked"]);
    oldB = await git(["rev-parse", "feat/b"]);

    const result = await command([bin, "restack-layer", "-P", "Proj"], join(repo, "sub"));
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toBe("restack-layer: an ignored file in this checkout sits where the rebase adds one\n");
    expect(await readFile(join(repo, "collision"), "utf8")).toBe("private file\n");
    expect(await git(["rev-parse", "feat/b"])).toBe(oldB);
  }, 60_000);

  test("layer-binary-marker", async () => {
    await fresh("layer-binary-marker");
    await git(["checkout", "--quiet", "feat/b"]);
    await writeFixture(repo, ".gitattributes", "round -diff\n");
    await commit("feat/b", "chore: mark round binary", [".gitattributes"]);
    await staleB(true);
    await conflict();
    await resolveRound("resolved\n<<<<<<< HEAD\nretained");
    const rebasedB = await git(["rev-parse", "feat/b"]);

    const result = await refusal("conflict marker left in round", "--push");
    expect(result.stderr).toBe("restack-layer: conflict marker left in round\n");
    await tip("feat/b", rebasedB, oldB);
    await tip("feat/c", oldC);
    expect(await config("branch.feat/b.skills-restack-lease")).toBe(oldB);
  }, 60_000);

  test("layer-readme-underline", async () => {
    await fresh("layer-readme-underline");
    await staleB();
    await layerSuccess("rebased feat/b onto feat/a, run the standing checks, then skills restack-layer --push");
    await writeFixture(repo, "README", "Heading\n=======\n");
    await git(["add", "--", "README"]);
    await git(["commit", "--quiet", "-m", "docs: add readme"]);

    await layerSuccess("pushed feat/b\nrebased feat/c and pushed", "--push");
    await pushed();
  }, 60_000);

  test("layer-fork-point-missing", async () => {
    await fresh("layer-fork-point-missing");
    await staleB();
    await git(["reflog", "expire", "--expire=all", "refs/heads/feat/a"]);
    expect((await command(["git", "merge-base", "--fork-point", "feat/a", "feat/b"])).stdout).toBe("");

    const reason = "cannot find where feat/b forked from feat/a, pass --onto <parent> <old parent tip>";
    const result = await refusal(reason);
    expect(result.stderr).toBe(`restack-layer: ${reason}\n`);
    await unchanged();
    expect(await config("branch.feat/b.skills-restack-lease")).toBe("");
  }, 60_000);

  test("layer-rebase-hook-failure", async () => {
    await fresh("layer-rebase-hook-failure");
    await staleB();
    await executable("layer-rebase-hook-failure/Proj/.git/hooks/pre-rebase", "#!/bin/sh\nexit 1\n");

    await refusal("cannot rebase feat/b onto feat/a:");
    await unchanged();
    expect(existsSync(join(repo, ".git/rebase-merge"))).toBe(false);
    expect(existsSync(join(repo, ".git/rebase-apply"))).toBe(false);
    expect(await config("branch.feat/b.skills-restack-lease")).toBe("");
    await git(["config", "branch.feat/b.skills-restack-lease", oldB]);
    await refusal("cannot rebase feat/b onto feat/a:");
    expect(await config("branch.feat/b.skills-restack-lease")).toBe(oldB);
  }, 60_000);

  test("layer-abort-origin-synced", async () => {
    await fresh("layer-abort-origin-synced");
    await staleB(true);
    await conflict();
    await succeed(["git", "rebase", "--abort"]);
    const racedB = await race("abort-racer", ["racer"], "fix: raced after abort");
    await git(["fetch", "--quiet", "origin", "feat/b"]);
    await git(["reset", "--quiet", "--hard", racedB]);

    await conflict("feat/b", "feat/a", racedB);
    await tip("feat/b", racedB);
    await tip("feat/c", oldC);
    await succeed(["git", "rebase", "--abort"]);
  }, 60_000);

  test("layer-stale-origin-moved", async () => {
    await fresh("layer-stale-origin-moved");
    await staleB();
    await layerSuccess("rebased feat/b onto feat/a, run the standing checks, then skills restack-layer --push");
    const rebasedB = await git(["rev-parse", "feat/b"]);
    await git(["checkout", "--quiet", "feat/a"]);
    await appendFile(join(repo, "a"), "next\n");
    await commit("feat/a", "fix: move parent again", ["a"]);
    await git(["checkout", "--quiet", "feat/b"]);
    const racedB = await race("stale-racer", [], "fix: raced stale layer");

    const result = await refusal(movedOrigin);
    expect(result.stderr).toBe(`restack-layer: ${movedOrigin}\n`);
    await tip("feat/b", rebasedB, racedB);
    await tip("feat/c", oldC);
    expect(await config("branch.feat/b.skills-restack-lease")).toBe(oldB);
  }, 60_000);

  test("layer-origin-fork-fallback", async () => {
    await fresh("layer-origin-fork-fallback");
    await git(["checkout", "--quiet", "main"]);
    await writeFixture(repo, "main-change", "main change\n");
    await commit("main", "feat: advance main", ["main-change"]);
    await git(["fetch", "--quiet", "origin", "main"]);
    await git(["reflog", "expire", "--expire=all", "refs/remotes/origin/main"]);
    await git(["checkout", "--quiet", "feat/b"]);
    await git(["config", "branch.feat/b.skills-base", "origin/main"]);
    oldB = await git(["rev-parse", "feat/b"]);
    oldC = await git(["rev-parse", "feat/c"]);
    expect((await command(["git", "merge-base", "--fork-point", "origin/main", "feat/b"])).stdout).toBe("");

    await layerSuccess("rebased feat/b onto origin/main, run the standing checks, then skills restack-layer --push");
    await git(["merge-base", "--is-ancestor", "origin/main", "feat/b"]);
    await tip("feat/b", await git(["rev-parse", "feat/b"]), oldB);
    await tip("feat/c", oldC);
    expect(await config("branch.feat/b.skills-restack-lease")).toBe(oldB);
  }, 60_000);

  test("layer-squash-recovery", async () => {
    await fresh("layer-squash-recovery");
    await git(["checkout", "--quiet", "feat/b"]);
    await writeFixture(repo, "round", "b change\n");
    await commit("feat/b", "feat: b edits round", ["round"]);
    const oldA = await git(["rev-parse", "feat/a"]);
    oldB = await git(["rev-parse", "feat/b"]);
    oldC = await git(["rev-parse", "feat/c"]);
    await git(["checkout", "--quiet", "main"]);
    await git(["merge", "--squash", "feat/a"]);
    await writeFixture(repo, "round", "squashed parent\n");
    await commit("main", "feat: squash a", ["round"]);
    const holder = await holderAt("squash-held-b", "feat/b");
    const before = await holderState(holder);

    const reason = `lease-rebase: rebase conflict on feat/b onto origin/main, row 2 of Proj, held by ${holder}, then skills restack-layer --onto origin/main ${oldA}`;
    const result = await command([bin, "lease-rebase", "origin/main", oldA, "feat/b", "feat/c"]);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`${reason}\n`);
    await unchanged();
    expect(await holderState(holder)).toEqual(before);

    await git(["update-ref", "refs/remotes/origin/main", await git(["rev-parse", "main^"])]);
    repo = holder;
    await conflict("feat/b", "origin/main", oldB, "--onto", "origin/main", oldA);
    expect(await git(["rev-parse", "origin/main"])).toBe(await git([`--git-dir=${origin}`, "rev-parse", "main"]));
    expect(await config("branch.feat/b.skills-restack-onto")).toBe(`origin/main ${oldA}`);
    expect(await config("branch.feat/b.skills-base")).toBe("feat/a");
    await unchanged();
    await refusal("unmerged paths in feat/b: round");
    await resolveRound();
    const rebasedB = await git(["rev-parse", "feat/b"]);
    await refusal("--onto conflicts with the recorded restack", "--onto", "feat/a", oldA);
    await tip("feat/b", rebasedB, oldB);
    await tip("feat/c", oldC);

    await layerSuccess("feat/b is rebased, run the standing checks, then skills restack-layer --push");
    await layerSuccess("pushed feat/b\nrebased feat/c and pushed", "--push");
    await tip("feat/b", rebasedB);
    const newC = await git(["rev-parse", "feat/c"]);
    await tip("feat/c", newC);
    expect(newC).not.toBe(oldC);
    await git(["merge-base", "--is-ancestor", "origin/main", "feat/b"]);
    await git(["merge-base", "--is-ancestor", "feat/b", "feat/c"]);
    expect(await git(["rev-list", "--count", "origin/main..feat/b"])).toBe("2");
    expect(await config("branch.feat/b.skills-base")).toBe("origin/main");
    expect(await config("branch.feat/b.skills-restack-onto")).toBe("");
    expect(await config("branch.feat/b.skills-restack-lease")).toBe("");
  }, 60_000);

  test("layer-onto-validation", async () => {
    await fresh("layer-onto-validation");
    await staleB();
    await refusal("no such commit: missing-cutoff", "--onto", "feat/a", "missing-cutoff");
    const oldA = await git(["rev-parse", "feat/a"]);
    await refusal(`${oldA} is not an ancestor of feat/b`, "--onto", "feat/a", oldA);
    await unchanged();
    expect(await config("branch.feat/b.skills-restack-lease")).toBe("");
    expect(await config("branch.feat/b.skills-restack-onto")).toBe("");
  }, 60_000);

  test("layer-operation-guards", async () => {
    await fresh("layer-operation-guards");
    await staleB();
    for (const operation of ["MERGE_HEAD", "BISECT_LOG", "rebase-apply", "rebase-merge"]) {
      const directory = operation.startsWith("rebase-");
      if (directory) await mkdir(join(repo, ".git", operation));
      else await writeFile(join(repo, ".git", operation), `${await git(["rev-parse", "HEAD"])}\n`);

      const reason = operation === "rebase-apply" ? "git am in progress"
        : operation === "rebase-merge" ? "rebase in progress with no branch"
        : `${operation} in progress on feat/b`;

      await refusal(reason);
      await unchanged();
      expect(await config("branch.feat/b.skills-restack-lease")).toBe("");
      await rm(join(repo, ".git", operation), { recursive: true });
    }
  }, 60_000);

  test("layer-rebase-without-unmerged", async () => {
    await fresh("layer-rebase-without-unmerged");
    await staleB(true);
    await conflict();
    await writeFixture(repo, "round", "resolved\n");
    await git(["add", "--", "round"]);
    expect(await git(["ls-files", "-u"])).toBe("");

    await refusal("rebase of feat/b still in progress, finish it with GIT_EDITOR=true git rebase --continue");
    await unchanged();
    expect(await config("branch.feat/b.skills-restack-lease")).toBe(oldB);
    await succeed(["git", "rebase", "--abort"]);
  }, 60_000);

  test("layer-active-row", async () => {
    await fresh("layer-active-row");
    await staleB(true);
    await git(["checkout", "--quiet", "feat/a"]);
    await writeFile(index, "id\ta\tb\tc\td\te\tf\tbranch\n8\t-\tDONE\t-\t-\t-\t-\tfeat/b\n9\t-\tDROPPED\t-\t-\t-\t-\tfeat/b\n2\t-\tREVIEW\t-\t-\t-\t-\tfeat/b\n1\t-\tREVIEW\t-\t-\t-\t-\tfeat/a\n3\t-\tREVIEW\t-\t-\t-\t-\tfeat/c\n");

    const result = await command([bin, "lease-rebase", "feat/a", await git(["merge-base", "feat/a", "feat/b"]), "feat/b", "feat/c"]);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("lease-rebase: rebase conflict on feat/b onto feat/a, row 2 of Proj, held by no checkout\n");
    await unchanged();
  }, 60_000);

  test("layer-merge-push", async () => {
    await fresh("layer-merge-push");
    await staleB();
    await layerSuccess("rebased feat/b onto feat/a, run the standing checks, then skills restack-layer --push");
    await git(["checkout", "--quiet", "-b", "merge-side"]);
    await writeFixture(repo, "side", "side\n");
    await git(["add", "--", "side"]);
    await git(["commit", "--quiet", "-m", "feat: side change"]);
    await git(["checkout", "--quiet", "feat/b"]);
    await git(["merge", "--quiet", "--no-ff", "-m", "feat: merge side", "merge-side"]);
    const rebasedB = await git(["rev-parse", "feat/b"]);

    await refusal("merge commit in feat/b, rebase it linear", "--push");
    await tip("feat/b", rebasedB, oldB);
    await tip("feat/c", oldC);
    expect(await config("branch.feat/b.skills-restack-lease")).toBe(oldB);
  }, 60_000);

  test("layer-tracked-stale", async () => {
    await fresh("layer-tracked-stale");
    await staleB();
    await appendFile(join(repo, "b"), "dirty\n");

    await refusal("tracked changes");
    await unchanged();
    expect(await readFile(join(repo, "b"), "utf8")).toBe("b1\ndirty\n");
    expect(await config("branch.feat/b.skills-restack-lease")).toBe("");
  }, 60_000);

  test("layer-conflict", async () => {
    await fresh("layer-conflict");
    await staleB(true);
    await conflict();
    await unchanged();
    expect((await command(["git", "symbolic-ref", "--quiet", "HEAD"])).stdout).toBe("");
    await refusal("unmerged paths in feat/b: round, resolve them, git add, then GIT_EDITOR=true git rebase --continue");
    await unchanged();

    await resolveRound("resolved\n<<<<<<< HEAD\nkept marker");
    const rebasedB = await git(["rev-parse", "feat/b"]);
    await refusal("conflict marker left in round", "--push");
    await tip("feat/b", rebasedB, oldB);
    await tip("feat/c", oldC);
    expect(await config("branch.feat/b.skills-restack-lease")).toBe(oldB);
    await writeFixture(repo, "round", "resolved\n");
    await git(["add", "--", "round"]);
    await git(["commit", "--quiet", "-m", "fix: remove conflict marker"]);

    await layerSuccess("pushed feat/b\nrebased feat/c and pushed", "--push");
    await pushed();
    const newB = await git(["rev-parse", "feat/b"]);
    const newC = await git(["rev-parse", "feat/c"]);
    await layerSuccess("feat/b already sits on feat/a");
    await tip("feat/b", newB);
    await tip("feat/c", newC);
  }, 60_000);

  test("layer-origin-moved", async () => {
    await fresh("layer-origin-moved");
    await staleB(true);
    await conflict();
    await resolveRound();
    const rebasedB = await git(["rev-parse", "feat/b"]);
    const racedB = await race("layer-racer", ["race"]);

    await refusal(movedOrigin, "--push");
    await tip("feat/b", rebasedB, racedB);
    await tip("feat/c", oldC);
    expect(await config("branch.feat/b.skills-restack-lease")).toBe(oldB);
  }, 60_000);

  test("layer-clean", async () => {
    await fresh("layer-clean");
    await staleB();
    await refusal("feat/b is still stale on feat/a, run skills restack-layer without --push", "--push");
    await unchanged();
    expect(await config("branch.feat/b.skills-restack-lease")).toBe("");

    await layerSuccess("rebased feat/b onto feat/a, run the standing checks, then skills restack-layer --push");
    const rebasedB = await git(["rev-parse", "feat/b"]);
    expect(rebasedB).not.toBe(oldB);
    await tip("feat/b", rebasedB, oldB);
    await tip("feat/c", oldC);
    expect(await config("branch.feat/b.skills-restack-lease")).toBe(oldB);

    await layerSuccess("feat/b is rebased, run the standing checks, then skills restack-layer --push");
    await tip("feat/b", rebasedB, oldB);
    await tip("feat/c", oldC);
    await layerSuccess("pushed feat/b\nrebased feat/c and pushed", "--push");
    await pushed();
  }, 60_000);

  test("layer-abort", async () => {
    await fresh("layer-abort");
    await staleB(true);
    await conflict();
    await succeed(["git", "rebase", "--abort"]);
    await unchanged();
    await conflict();
    await unchanged();
    await succeed(["git", "rebase", "--abort"]);
  }, 60_000);

  test("layer-base-moved", async () => {
    await fresh("layer-base-moved");
    await staleB();
    await layerSuccess("rebased feat/b onto feat/a, run the standing checks, then skills restack-layer --push");
    const rebasedB = await git(["rev-parse", "feat/b"]);
    await tip("feat/b", rebasedB, oldB);
    await tip("feat/c", oldC);
    await git(["checkout", "--quiet", "feat/a"]);
    await appendFile(join(repo, "a"), "another a change\n");
    await commit("feat/a", "fix: a moves again", ["a"]);
    await git(["checkout", "--quiet", "feat/b"]);

    await refusal("feat/b is still stale on feat/a, run skills restack-layer without --push", "--push");
    await tip("feat/b", rebasedB, oldB);
    await tip("feat/c", oldC);
    await layerSuccess("rebased feat/b onto feat/a, run the standing checks, then skills restack-layer --push");
    const secondB = await git(["rev-parse", "feat/b"]);
    expect(secondB).not.toBe(rebasedB);
    await tip("feat/b", secondB, oldB);
    await tip("feat/c", oldC);
    expect(await config("branch.feat/b.skills-restack-lease")).toBe(oldB);
    await layerSuccess("pushed feat/b\nrebased feat/c and pushed", "--push");
    await pushed();
  }, 60_000);

  test("layer-current", async () => {
    await fresh("layer-current");
    await git(["checkout", "--quiet", "feat/b"]);
    oldB = await git(["rev-parse", "feat/b"]);
    oldC = await git(["rev-parse", "feat/c"]);
    for (const args of [[], ["--push"]]) {
      await layerSuccess("feat/b already sits on feat/a", ...args);
      await unchanged();
    }

    await appendFile(join(repo, "b"), "dirty\n");
    await writeFile(index, (await readFile(index, "utf8")).replace("3\t-\t-\t-", "3\t-\tDOING\t-"));
    for (const args of [[], ["--push"]]) {
      await layerSuccess("feat/b already sits on feat/a", ...args);
      await unchanged();
    }
  }, 60_000);

  test("layer-upper-conflict", async () => {
    await fresh("layer-upper-conflict");
    await git(["checkout", "--quiet", "feat/c"]);
    await appendFile(join(repo, "round"), "c change\n");
    await commit("feat/c", "feat: c edits round", ["round"]);
    await git(["checkout", "--quiet", "feat/a"]);
    oldB = await git(["rev-parse", "feat/b"]);
    oldC = await git(["rev-parse", "feat/c"]);
    const holder = await holderAt("layer-held-c");
    const before = await holderState(holder);
    await appendFile(join(repo, "round"), "a change\n");

    const fixed = await command([bin, "fix-round", "-P", "Proj", "-m", "fix: guard empty input", "round"]);
    const reason = "fix-round: rebase conflict on feat/c onto feat/b, restack feat/b first, row 2 of Proj, held by no checkout, the round is pushed on feat/a, every layer above it is untouched";
    expect(fixed.code, fixed.stderr).toBe(1);
    expect(fixed.stdout).toBe("");
    expect(fixed.stderr.split("\n")).toContain(reason);
    await unchanged();
    expect(await holderState(holder)).toEqual(before);

    await git(["checkout", "--quiet", "feat/b"]);
    await layerSuccess("rebased feat/b onto feat/a, run the standing checks, then skills restack-layer --push");
    const rebasedB = await git(["rev-parse", "feat/b"]);
    await tip("feat/b", rebasedB, oldB);
    await tip("feat/c", oldC);
    const rejected = await refusal(`rebase conflict on feat/c onto feat/b, row 3 of Proj, held by ${holder}, feat/b is pushed, every layer above it is untouched`, "--push");
    expect(rejected.stderr.trimEnd()).toBe(`restack-layer: rebase conflict on feat/c onto feat/b, row 3 of Proj, held by ${holder}, feat/b is pushed, every layer above it is untouched`);
    await tip("feat/b", rebasedB);
    await tip("feat/c", oldC);
    expect(await config("branch.feat/b.skills-restack-lease")).toBe("");
    expect(await holderState(holder)).toEqual(before);

    repo = holder;
    await conflict("feat/c", "feat/b", oldC);
    await tip("feat/b", rebasedB);
    await tip("feat/c", oldC);
    await resolveRound();
    const rebasedC = await git(["rev-parse", "feat/c"]);
    await tip("feat/c", rebasedC, oldC);
    await layerSuccess("pushed feat/c", "--push");
    await tip("feat/b", rebasedB);
    await tip("feat/c", rebasedC);
    await git(["merge-base", "--is-ancestor", "feat/b", "feat/c"]);
    expect(await config("branch.feat/c.skills-restack-lease")).toBe("");
  }, 60_000);
});

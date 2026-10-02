import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeFixture } from "../test/fixtures.ts";
import type { CommandResult } from "../test/process.ts";
import { stackCase, stackRepo, type StackCase, type StackVerb } from "../test/stack-fixture.ts";
import { fixRoundVerb } from "./fix-round.ts";
import { leaseRebaseVerb } from "./lease-rebase.ts";
import { restackLayerVerb } from "./restack-layer.ts";

setDefaultTimeout(60_000);

const bin = resolve(import.meta.dir, "../../skills/playbook/bin/skills");
const root = resolve(import.meta.dir, "../../skills");
const usage = "skills restack-layer -P <Project> [--push] [--onto <parent> <old parent tip>]";
const restackLayer: StackVerb = (args, io) => restackLayerVerb(args, usage, root, io);
const leaseRebase: StackVerb = (args, io) =>
  leaseRebaseVerb(args, "skills lease-rebase <parent> <parent-old-tip> <branch>...", root, io);
const fixRound: StackVerb = (args, io) =>
  fixRoundVerb(args, 'skills fix-round -P <Project> -m "<message>" <file>...', root, io);

async function layerCase(fixture: StackCase, name: string) {
  const { temporary, env, executable } = fixture;
  const repository = await stackRepo(fixture, {
    name,
    directory: `${name}/Proj`,
    commits: [
      { branch: "main", message: "chore: initial", files: { shared: "base\n", round: "a\n" } },
      { branch: "feat/a", base: "origin/main", message: "feat: a", files: { a: "a1\n" } },
      { branch: "feat/b", base: "feat/a", message: "feat: b", files: { b: "b1\n" } },
      { branch: "feat/c", base: "feat/b", message: "feat: c", files: { c: "c1\n" } },
    ],
    checkout: "feat/a",
    index: {
      project: "Proj",
      text: "id\ta\tb\tc\td\te\tf\tbranch\n1\t-\t-\t-\t-\t-\t-\tfeat/a\n2\t-\t-\t-\t-\t-\t-\tfeat/b\n3\t-\t-\t-\t-\t-\t-\tfeat/c\n",
    },
  });

  const index = repository.index!;
  const state = { repo: repository.repo, origin: repository.origin, oldB: "", oldC: "" };
  async function git(args: readonly string[], cwd = state.repo): Promise<string> {
    return fixture.git(args, cwd);
  }

  async function command(argv: readonly string[], cwd = state.repo): Promise<CommandResult> {
    return fixture.command(argv, cwd);
  }

  async function run(
    verb: StackVerb,
    args: readonly string[],
    cwd = state.repo,
  ): Promise<CommandResult> {
    return fixture.run(verb, args, cwd);
  }

  async function succeed(argv: readonly string[], cwd = state.repo): Promise<CommandResult> {
    const result = await command(argv, cwd);
    expect(result.code, result.stderr).toBe(0);
    return result;
  }

  async function commit(
    branch: string,
    message: string,
    files: string[],
    cwd = state.repo,
  ): Promise<void> {
    await repository.commit(branch, message, files, cwd);
  }

  async function holderAt(name: string, branch = "feat/c"): Promise<string> {
    return fixture.holderAt(name, branch, state.repo);
  }

  async function holderState(holder: string): Promise<{ head: string; tree: string }> {
    return {
      head: await git(["rev-parse", "HEAD"], holder),
      tree: await git(["status", "--porcelain"], holder),
    };
  }

  async function branches(): Promise<{
    local: string;
    remote: string;
    tree: string;
    branch: string;
  }> {
    const refs = ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"];
    return {
      local: await git(refs),
      remote: await git([`--git-dir=${state.origin}`, ...refs]),
      tree: await git(["status", "--porcelain"]),
      branch: await git(["branch", "--show-current"]),
    };
  }

  async function tip(branch: string, local: string, remote = local): Promise<void> {
    expect(await git(["rev-parse", branch])).toBe(local);
    expect(await git([`--git-dir=${state.origin}`, "rev-parse", branch])).toBe(remote);
  }

  async function layer(...args: string[]): Promise<CommandResult> {
    return run(restackLayer, ["-P", "Proj", ...args]);
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
      await writeFixture(state.repo, "round", "b change\n");
      await commit("feat/b", "feat: b edits round", ["round"]);
    }

    await git(["checkout", "--quiet", "feat/a"]);
    await writeFixture(state.repo, "round", "a change\n");
    await commit("feat/a", "fix: a edits round", ["round"]);

    state.oldB = await git(["rev-parse", "feat/b"]);
    state.oldC = await git(["rev-parse", "feat/c"]);
    await git(["checkout", "--quiet", "feat/b"]);
  }

  async function unchanged(): Promise<void> {
    await tip("feat/b", state.oldB);
    await tip("feat/c", state.oldC);
  }

  async function conflict(
    branch = "feat/b",
    base = "feat/a",
    lease = state.oldB,
    ...args: string[]
  ): Promise<void> {
    await refusal(
      `conflict rebasing ${branch} onto ${base}, resolve it here, git add, GIT_EDITOR=true git rebase --continue, run the standing checks, then skills restack-layer --push`,
      ...args,
    );

    const admin = await git(["rev-parse", "--absolute-git-dir"]);
    expect(existsSync(join(admin, "rebase-merge")) || existsSync(join(admin, "rebase-apply"))).toBe(
      true,
    );

    expect(await config(`branch.${branch}.skills-restack-lease`)).toBe(lease);
  }

  async function resolveRound(content = "resolved"): Promise<void> {
    await writeFixture(state.repo, "round", `${content}\n`);
    await git(["add", "--", "round"]);
    await succeed(["git", "rebase", "--continue"]);
  }

  async function pushed(): Promise<void> {
    const newB = await git(["rev-parse", "feat/b"]);
    const newC = await git(["rev-parse", "feat/c"]);
    expect(newB).not.toBe(state.oldB);

    expect(newC).not.toBe(state.oldC);
    await tip("feat/b", newB);
    await tip("feat/c", newC);

    await git(["merge-base", "--is-ancestor", "feat/a", "feat/b"]);
    await git(["merge-base", "--is-ancestor", "feat/b", "feat/c"]);
    expect(await config("branch.feat/b.skills-restack-lease")).toBe("");
  }

  async function race(
    racerName: string,
    files: string[] = [],
    message = "fix: raced b",
  ): Promise<string> {
    const racer = await fixture.clone(state.origin, racerName);
    await git(["checkout", "--quiet", "feat/b"], racer);

    for (const file of files) await writeFixture(racer, file, `${file}\n`);

    return repository.commit("feat/b", message, files, racer);
  }

  return {
    temporary,
    env,
    state,
    index,
    executable,
    git,
    command,
    run,
    succeed,
    commit,
    holderAt,
    holderState,
    branches,
    tip,
    layer,
    layerSuccess,
    refusal,
    config,
    staleB,
    unchanged,
    conflict,
    resolveRound,
    pushed,
    race,
  };
}

describe("restack-layer checkout guards", () => {
  test.concurrent("wrong checkout", async () => {
    const fixture = await stackCase("skills-restack-layer-", { assertNoGhCalls: true });
    try {
      const { state, git, run, branches } = await layerCase(fixture, "wrong-checkout");
      const other = await stackRepo(fixture, {
        name: "other",
        commits: [{ branch: "main", message: "chore: initial" }],
        checkout: "main",
      });

      await other.branch("feat/other", "main");
      await other.git(["checkout", "--quiet", "feat/other"]);

      state.repo = other.repo;
      state.origin = other.origin;
      const before = await branches();
      const remote = await git(["ls-remote", "origin"]);

      const result = await run(restackLayer, ["-P", "fixture"]);
      expect(result.code, result.stderr).toBe(1);
      expect(result.stdout).toBe("");

      expect(result.stderr).toContain(
        "restack-layer: this checkout is other, not a checkout of fixture",
      );

      expect(await branches()).toEqual(before);
      expect(await git(["ls-remote", "origin"])).toBe(remote);
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("matching worktree without index", async () => {
    const fixture = await stackCase("skills-restack-layer-", { assertNoGhCalls: true });
    try {
      const { index, run, holderAt } = await layerCase(fixture, "matching-worktree");
      const holder = await holderAt("t3code-0000");
      await rm(index);

      const result = await run(restackLayer, ["-P", "Proj"], holder);
      expect(result.code, result.stderr).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("restack-layer: no index.tsv for Proj");
      expect(result.stderr).not.toContain("not a checkout of");
    } finally {
      await fixture.dispose();
    }
  });
});

const movedOrigin =
  "origin/feat/b moved since the rebase began, nothing pushed; sync feat/b with origin, or drop the restack with git config --unset branch.feat/b.skills-restack-lease";

describe("restack-layer legacy cases", () => {
  test.concurrent("layer-no-update-refs", async () => {
    const fixture = await stackCase("skills-restack-layer-", { assertNoGhCalls: true });
    try {
      const { state, git, tip, layerSuccess, staleB } = await layerCase(
        fixture,
        "layer-no-update-refs",
      );

      await staleB();
      await git(["config", "rebase.updateRefs", "true"]);
      await git(["branch", "bystander", "feat/b"]);

      await layerSuccess(
        "rebased feat/b onto feat/a, run the standing checks, then skills restack-layer --push",
      );

      expect(await git(["rev-parse", "bystander"])).toBe(state.oldB);
      await tip("feat/b", await git(["rev-parse", "feat/b"]), state.oldB);
      await tip("feat/c", state.oldC);
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("layer-ignored-collision", async () => {
    const fixture = await stackCase("skills-restack-layer-", { assertNoGhCalls: true });
    try {
      const { state, git, commit, refusal, config, unchanged } = await layerCase(
        fixture,
        "layer-ignored-collision",
      );

      await writeFixture(state.repo, "collision", "parent file\n");
      await commit("feat/a", "feat: add collision", ["collision"]);

      state.oldB = await git(["rev-parse", "feat/b"]);
      state.oldC = await git(["rev-parse", "feat/c"]);
      await git(["checkout", "--quiet", "feat/b"]);

      await appendFile(join(state.repo, ".git/info/exclude"), "collision\n");
      await writeFixture(state.repo, "collision", "private file\n");

      await refusal("an ignored file in this checkout sits where the rebase adds one");
      await unchanged();
      expect(await readFile(join(state.repo, "collision"), "utf8")).toBe("private file\n");

      expect(await config("branch.feat/b.skills-restack-lease")).toBe("");
      expect(existsSync(join(state.repo, ".git/rebase-merge"))).toBe(false);
      expect(existsSync(join(state.repo, ".git/rebase-apply"))).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("ignored collision at the root, run from a subdirectory", async () => {
    const fixture = await stackCase("skills-restack-layer-", { assertNoGhCalls: true });
    try {
      const { state, git, run, commit } = await layerCase(
        fixture,
        "layer-ignored-collision-subdirectory",
      );

      await writeFixture(state.repo, "collision", "parent file\n");
      await commit("feat/a", "feat: add collision", ["collision"]);

      state.oldB = await git(["rev-parse", "feat/b"]);
      state.oldC = await git(["rev-parse", "feat/c"]);
      await git(["checkout", "--quiet", "feat/b"]);

      await appendFile(join(state.repo, ".git/info/exclude"), "collision\n");
      await writeFixture(state.repo, "collision", "private file\n");
      await writeFixture(state.repo, "sub/tracked", "sub\n");

      await commit("feat/b", "feat: add sub", ["sub/tracked"]);
      state.oldB = await git(["rev-parse", "feat/b"]);

      const result = await run(restackLayer, ["-P", "Proj"], join(state.repo, "sub"));
      expect(result.code, result.stderr).toBe(1);
      expect(result.stderr).toBe(
        "restack-layer: an ignored file in this checkout sits where the rebase adds one\n",
      );

      expect(await readFile(join(state.repo, "collision"), "utf8")).toBe("private file\n");
      expect(await git(["rev-parse", "feat/b"])).toBe(state.oldB);
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("layer-binary-marker", async () => {
    const fixture = await stackCase("skills-restack-layer-", { assertNoGhCalls: true });
    try {
      const { state, git, commit, tip, refusal, config, staleB, conflict, resolveRound } =
        await layerCase(fixture, "layer-binary-marker");

      await git(["checkout", "--quiet", "feat/b"]);
      await writeFixture(state.repo, ".gitattributes", "round -diff\n");

      await commit("feat/b", "chore: mark round binary", [".gitattributes"]);
      await staleB(true);
      await conflict();

      await resolveRound("resolved\n<<<<<<< HEAD\nretained");
      const rebasedB = await git(["rev-parse", "feat/b"]);

      const result = await refusal("conflict marker left in round", "--push");
      expect(result.stderr).toBe("restack-layer: conflict marker left in round\n");
      await tip("feat/b", rebasedB, state.oldB);
      await tip("feat/c", state.oldC);
      expect(await config("branch.feat/b.skills-restack-lease")).toBe(state.oldB);
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("layer-readme-underline", async () => {
    const fixture = await stackCase("skills-restack-layer-", { assertNoGhCalls: true });
    try {
      const { state, git, layerSuccess, staleB, pushed } = await layerCase(
        fixture,
        "layer-readme-underline",
      );

      await staleB();
      await layerSuccess(
        "rebased feat/b onto feat/a, run the standing checks, then skills restack-layer --push",
      );

      await writeFixture(state.repo, "README", "Heading\n=======\n");
      await git(["add", "--", "README"]);
      await git(["commit", "--quiet", "-m", "docs: add readme"]);

      await layerSuccess("pushed feat/b\nrebased feat/c and pushed", "--push");
      await pushed();
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("layer-fork-point-missing", async () => {
    const fixture = await stackCase("skills-restack-layer-", { assertNoGhCalls: true });
    try {
      const { git, command, refusal, config, staleB, unchanged } = await layerCase(
        fixture,
        "layer-fork-point-missing",
      );

      await staleB();
      await git(["reflog", "expire", "--expire=all", "refs/heads/feat/a"]);
      expect(
        (await command(["git", "merge-base", "--fork-point", "feat/a", "feat/b"])).stdout,
      ).toBe("");

      const reason =
        "cannot find where feat/b forked from feat/a, pass --onto <parent> <old parent tip>";

      const result = await refusal(reason);
      expect(result.stderr).toBe(`restack-layer: ${reason}\n`);
      await unchanged();
      expect(await config("branch.feat/b.skills-restack-lease")).toBe("");
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("layer-rebase-hook-failure", async () => {
    const fixture = await stackCase("skills-restack-layer-", { assertNoGhCalls: true });
    try {
      const { state, executable, git, refusal, config, staleB, unchanged } = await layerCase(
        fixture,
        "layer-rebase-hook-failure",
      );

      await staleB();
      await executable(
        "layer-rebase-hook-failure/Proj/.git/hooks/pre-rebase",
        "#!/bin/sh\nexit 1\n",
      );

      await refusal("cannot rebase feat/b onto feat/a:");
      await unchanged();
      expect(existsSync(join(state.repo, ".git/rebase-merge"))).toBe(false);

      expect(existsSync(join(state.repo, ".git/rebase-apply"))).toBe(false);
      expect(await config("branch.feat/b.skills-restack-lease")).toBe("");
      await git(["config", "branch.feat/b.skills-restack-lease", state.oldB]);

      await refusal("cannot rebase feat/b onto feat/a:");
      expect(await config("branch.feat/b.skills-restack-lease")).toBe(state.oldB);
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("layer-abort-origin-synced", async () => {
    const fixture = await stackCase("skills-restack-layer-", { assertNoGhCalls: true });
    try {
      const { state, git, succeed, tip, staleB, conflict, race } = await layerCase(
        fixture,
        "layer-abort-origin-synced",
      );

      await staleB(true);
      await conflict();

      await succeed(["git", "rebase", "--abort"]);
      const racedB = await race("abort-racer", ["racer"], "fix: raced after abort");
      await git(["fetch", "--quiet", "origin", "feat/b"]);

      await git(["reset", "--quiet", "--hard", racedB]);

      await conflict("feat/b", "feat/a", racedB);
      await tip("feat/b", racedB);
      await tip("feat/c", state.oldC);
      await succeed(["git", "rebase", "--abort"]);
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("layer-stale-origin-moved", async () => {
    const fixture = await stackCase("skills-restack-layer-", { assertNoGhCalls: true });
    try {
      const { state, git, commit, tip, layerSuccess, refusal, config, staleB, race } =
        await layerCase(fixture, "layer-stale-origin-moved");

      await staleB();
      await layerSuccess(
        "rebased feat/b onto feat/a, run the standing checks, then skills restack-layer --push",
      );

      const rebasedB = await git(["rev-parse", "feat/b"]);
      await git(["checkout", "--quiet", "feat/a"]);
      await appendFile(join(state.repo, "a"), "next\n");

      await commit("feat/a", "fix: move parent again", ["a"]);
      await git(["checkout", "--quiet", "feat/b"]);
      const racedB = await race("stale-racer", [], "fix: raced stale layer");

      const result = await refusal(movedOrigin);
      expect(result.stderr).toBe(`restack-layer: ${movedOrigin}\n`);
      await tip("feat/b", rebasedB, racedB);
      await tip("feat/c", state.oldC);
      expect(await config("branch.feat/b.skills-restack-lease")).toBe(state.oldB);
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("layer-origin-fork-fallback", async () => {
    const fixture = await stackCase("skills-restack-layer-", { assertNoGhCalls: true });
    try {
      const { state, git, command, commit, tip, layerSuccess, config } = await layerCase(
        fixture,
        "layer-origin-fork-fallback",
      );

      await git(["checkout", "--quiet", "main"]);
      await writeFixture(state.repo, "main-change", "main change\n");

      await commit("main", "feat: advance main", ["main-change"]);
      await git(["fetch", "--quiet", "origin", "main"]);
      await git(["reflog", "expire", "--expire=all", "refs/remotes/origin/main"]);

      await git(["checkout", "--quiet", "feat/b"]);
      await git(["config", "branch.feat/b.skills-base", "origin/main"]);
      state.oldB = await git(["rev-parse", "feat/b"]);

      state.oldC = await git(["rev-parse", "feat/c"]);
      expect(
        (await command(["git", "merge-base", "--fork-point", "origin/main", "feat/b"])).stdout,
      ).toBe("");

      await layerSuccess(
        "rebased feat/b onto origin/main, run the standing checks, then skills restack-layer --push",
      );

      await git(["merge-base", "--is-ancestor", "origin/main", "feat/b"]);
      await tip("feat/b", await git(["rev-parse", "feat/b"]), state.oldB);
      await tip("feat/c", state.oldC);
      expect(await config("branch.feat/b.skills-restack-lease")).toBe(state.oldB);
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("layer-squash-recovery", async () => {
    const fixture = await stackCase("skills-restack-layer-", { assertNoGhCalls: true });
    try {
      const {
        state,
        git,
        run,
        commit,
        holderAt,
        holderState,
        tip,
        layerSuccess,
        refusal,
        config,
        unchanged,
        conflict,
        resolveRound,
      } = await layerCase(fixture, "layer-squash-recovery");

      await git(["checkout", "--quiet", "feat/b"]);
      await writeFixture(state.repo, "round", "b change\n");

      await commit("feat/b", "feat: b edits round", ["round"]);
      const oldA = await git(["rev-parse", "feat/a"]);
      state.oldB = await git(["rev-parse", "feat/b"]);

      state.oldC = await git(["rev-parse", "feat/c"]);
      await git(["checkout", "--quiet", "main"]);
      await git(["merge", "--squash", "feat/a"]);

      await writeFixture(state.repo, "round", "squashed parent\n");
      await commit("main", "feat: squash a", ["round"]);
      const holder = await holderAt("squash-held-b", "feat/b");

      const before = await holderState(holder);

      const reason = `lease-rebase: rebase conflict on feat/b onto origin/main, row 2 of Proj, held by ${holder}, then skills restack-layer --onto origin/main ${oldA}`;
      const result = await run(leaseRebase, ["origin/main", oldA, "feat/b", "feat/c"]);
      expect(result.code, result.stderr).toBe(1);

      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(`${reason}\n`);
      await unchanged();

      expect(await holderState(holder)).toEqual(before);

      await git(["update-ref", "refs/remotes/origin/main", await git(["rev-parse", "main^"])]);
      state.repo = holder;
      await conflict("feat/b", "origin/main", state.oldB, "--onto", "origin/main", oldA);

      expect(await git(["rev-parse", "origin/main"])).toBe(
        await git([`--git-dir=${state.origin}`, "rev-parse", "main"]),
      );

      expect(await config("branch.feat/b.skills-restack-onto")).toBe(`origin/main ${oldA}`);
      expect(await config("branch.feat/b.skills-base")).toBe("feat/a");

      await unchanged();
      await refusal("unmerged paths in feat/b: round");
      await resolveRound();

      const rebasedB = await git(["rev-parse", "feat/b"]);
      await refusal("--onto conflicts with the recorded restack", "--onto", "feat/a", oldA);
      await tip("feat/b", rebasedB, state.oldB);

      await tip("feat/c", state.oldC);

      await layerSuccess(
        "feat/b is rebased, run the standing checks, then skills restack-layer --push",
      );

      await layerSuccess("pushed feat/b\nrebased feat/c and pushed", "--push");
      await tip("feat/b", rebasedB);

      const newC = await git(["rev-parse", "feat/c"]);
      await tip("feat/c", newC);
      expect(newC).not.toBe(state.oldC);

      await git(["merge-base", "--is-ancestor", "origin/main", "feat/b"]);
      await git(["merge-base", "--is-ancestor", "feat/b", "feat/c"]);
      expect(await git(["rev-list", "--count", "origin/main..feat/b"])).toBe("2");

      expect(await config("branch.feat/b.skills-base")).toBe("origin/main");
      expect(await config("branch.feat/b.skills-restack-onto")).toBe("");
      expect(await config("branch.feat/b.skills-restack-lease")).toBe("");
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("layer-onto-validation", async () => {
    const fixture = await stackCase("skills-restack-layer-", { assertNoGhCalls: true });
    try {
      const { git, refusal, config, staleB, unchanged } = await layerCase(
        fixture,
        "layer-onto-validation",
      );

      await staleB();
      await refusal("no such commit: missing-cutoff", "--onto", "feat/a", "missing-cutoff");

      const oldA = await git(["rev-parse", "feat/a"]);
      await refusal(`${oldA} is not an ancestor of feat/b`, "--onto", "feat/a", oldA);
      await unchanged();

      expect(await config("branch.feat/b.skills-restack-lease")).toBe("");
      expect(await config("branch.feat/b.skills-restack-onto")).toBe("");
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("layer-operation-guards", async () => {
    const fixture = await stackCase("skills-restack-layer-", { assertNoGhCalls: true });
    try {
      const { state, git, refusal, config, staleB, unchanged } = await layerCase(
        fixture,
        "layer-operation-guards",
      );

      await staleB();

      for (const operation of ["MERGE_HEAD", "BISECT_LOG", "rebase-apply", "rebase-merge"]) {
        const directory = operation.startsWith("rebase-");
        if (directory) await mkdir(join(state.repo, ".git", operation));
        else
          await writeFile(
            join(state.repo, ".git", operation),
            `${await git(["rev-parse", "HEAD"])}\n`,
          );

        const reason =
          operation === "rebase-apply"
            ? "git am in progress"
            : operation === "rebase-merge"
              ? "rebase in progress with no branch"
              : `${operation} in progress on feat/b`;

        await refusal(reason);
        await unchanged();
        expect(await config("branch.feat/b.skills-restack-lease")).toBe("");
        await rm(join(state.repo, ".git", operation), { recursive: true });
      }
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("layer-rebase-without-unmerged", async () => {
    const fixture = await stackCase("skills-restack-layer-", { assertNoGhCalls: true });
    try {
      const { state, git, succeed, refusal, config, staleB, unchanged, conflict } = await layerCase(
        fixture,
        "layer-rebase-without-unmerged",
      );

      await staleB(true);
      await conflict();

      await writeFixture(state.repo, "round", "resolved\n");
      await git(["add", "--", "round"]);
      expect(await git(["ls-files", "-u"])).toBe("");

      await refusal(
        "rebase of feat/b still in progress, finish it with GIT_EDITOR=true git rebase --continue",
      );

      await unchanged();
      expect(await config("branch.feat/b.skills-restack-lease")).toBe(state.oldB);
      await succeed(["git", "rebase", "--abort"]);
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("layer-active-row", async () => {
    const fixture = await stackCase("skills-restack-layer-", { assertNoGhCalls: true });
    try {
      const { index, git, run, staleB, unchanged } = await layerCase(fixture, "layer-active-row");
      await staleB(true);
      await git(["checkout", "--quiet", "feat/a"]);
      await writeFile(
        index,
        "id\ta\tb\tc\td\te\tf\tbranch\n8\t-\tDONE\t-\t-\t-\t-\tfeat/b\n9\t-\tDROPPED\t-\t-\t-\t-\tfeat/b\n2\t-\tREVIEW\t-\t-\t-\t-\tfeat/b\n1\t-\tREVIEW\t-\t-\t-\t-\tfeat/a\n3\t-\tREVIEW\t-\t-\t-\t-\tfeat/c\n",
      );

      const result = await run(leaseRebase, [
        "feat/a",
        await git(["merge-base", "feat/a", "feat/b"]),
        "feat/b",
        "feat/c",
      ]);

      expect(result.code, result.stderr).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        "lease-rebase: rebase conflict on feat/b onto feat/a, row 2 of Proj, held by no checkout\n",
      );

      await unchanged();
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("layer-merge-push", async () => {
    const fixture = await stackCase("skills-restack-layer-", { assertNoGhCalls: true });
    try {
      const { state, git, tip, layerSuccess, refusal, config, staleB } = await layerCase(
        fixture,
        "layer-merge-push",
      );

      await staleB();
      await layerSuccess(
        "rebased feat/b onto feat/a, run the standing checks, then skills restack-layer --push",
      );

      await git(["checkout", "--quiet", "-b", "merge-side"]);
      await writeFixture(state.repo, "side", "side\n");
      await git(["add", "--", "side"]);

      await git(["commit", "--quiet", "-m", "feat: side change"]);
      await git(["checkout", "--quiet", "feat/b"]);
      await git(["merge", "--quiet", "--no-ff", "-m", "feat: merge side", "merge-side"]);

      const rebasedB = await git(["rev-parse", "feat/b"]);

      await refusal("merge commit in feat/b, rebase it linear", "--push");
      await tip("feat/b", rebasedB, state.oldB);
      await tip("feat/c", state.oldC);
      expect(await config("branch.feat/b.skills-restack-lease")).toBe(state.oldB);
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("layer-tracked-stale", async () => {
    const fixture = await stackCase("skills-restack-layer-", { assertNoGhCalls: true });
    try {
      const { state, refusal, config, staleB, unchanged } = await layerCase(
        fixture,
        "layer-tracked-stale",
      );

      await staleB();
      await appendFile(join(state.repo, "b"), "dirty\n");

      await refusal("tracked changes");
      await unchanged();
      expect(await readFile(join(state.repo, "b"), "utf8")).toBe("b1\ndirty\n");
      expect(await config("branch.feat/b.skills-restack-lease")).toBe("");
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("layer-conflict", async () => {
    const fixture = await stackCase("skills-restack-layer-", { assertNoGhCalls: true });
    try {
      const {
        state,
        git,
        command,
        tip,
        layerSuccess,
        refusal,
        config,
        staleB,
        unchanged,
        conflict,
        resolveRound,
        pushed,
      } = await layerCase(fixture, "layer-conflict");

      await staleB(true);
      await conflict();

      await unchanged();
      expect((await command(["git", "symbolic-ref", "--quiet", "HEAD"])).stdout).toBe("");
      await refusal(
        "unmerged paths in feat/b: round, resolve them, git add, then GIT_EDITOR=true git rebase --continue",
      );

      await unchanged();

      await resolveRound("resolved\n<<<<<<< HEAD\nkept marker");
      const rebasedB = await git(["rev-parse", "feat/b"]);
      await refusal("conflict marker left in round", "--push");

      await tip("feat/b", rebasedB, state.oldB);
      await tip("feat/c", state.oldC);
      expect(await config("branch.feat/b.skills-restack-lease")).toBe(state.oldB);

      await writeFixture(state.repo, "round", "resolved\n");
      await git(["add", "--", "round"]);
      await git(["commit", "--quiet", "-m", "fix: remove conflict marker"]);

      await layerSuccess("pushed feat/b\nrebased feat/c and pushed", "--push");
      await pushed();
      const newB = await git(["rev-parse", "feat/b"]);

      const newC = await git(["rev-parse", "feat/c"]);
      await layerSuccess("feat/b already sits on feat/a");
      await tip("feat/b", newB);

      await tip("feat/c", newC);
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("layer-origin-moved", async () => {
    const fixture = await stackCase("skills-restack-layer-", { assertNoGhCalls: true });
    try {
      const { state, git, tip, refusal, config, staleB, conflict, resolveRound, race } =
        await layerCase(fixture, "layer-origin-moved");

      await staleB(true);
      await conflict();

      await resolveRound();
      const rebasedB = await git(["rev-parse", "feat/b"]);
      const racedB = await race("layer-racer", ["race"]);

      await refusal(movedOrigin, "--push");
      await tip("feat/b", rebasedB, racedB);
      await tip("feat/c", state.oldC);
      expect(await config("branch.feat/b.skills-restack-lease")).toBe(state.oldB);
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("layer-clean", async () => {
    const fixture = await stackCase("skills-restack-layer-", { assertNoGhCalls: true });
    try {
      const { state, git, tip, layerSuccess, refusal, config, staleB, unchanged, pushed } =
        await layerCase(fixture, "layer-clean");

      await staleB();
      await refusal(
        "feat/b is still stale on feat/a, run skills restack-layer without --push",
        "--push",
      );

      await unchanged();
      expect(await config("branch.feat/b.skills-restack-lease")).toBe("");

      await layerSuccess(
        "rebased feat/b onto feat/a, run the standing checks, then skills restack-layer --push",
      );

      const rebasedB = await git(["rev-parse", "feat/b"]);
      expect(rebasedB).not.toBe(state.oldB);

      await tip("feat/b", rebasedB, state.oldB);
      await tip("feat/c", state.oldC);
      expect(await config("branch.feat/b.skills-restack-lease")).toBe(state.oldB);

      await layerSuccess(
        "feat/b is rebased, run the standing checks, then skills restack-layer --push",
      );

      await tip("feat/b", rebasedB, state.oldB);
      await tip("feat/c", state.oldC);
      await layerSuccess("pushed feat/b\nrebased feat/c and pushed", "--push");
      await pushed();
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("layer-abort", async () => {
    const fixture = await stackCase("skills-restack-layer-", { assertNoGhCalls: true });
    try {
      const { succeed, staleB, unchanged, conflict } = await layerCase(fixture, "layer-abort");
      await staleB(true);
      await conflict();

      await succeed(["git", "rebase", "--abort"]);
      await unchanged();
      await conflict();

      await unchanged();
      await succeed(["git", "rebase", "--abort"]);
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("layer-base-moved", async () => {
    const fixture = await stackCase("skills-restack-layer-", { assertNoGhCalls: true });
    try {
      const { state, git, commit, tip, layerSuccess, refusal, config, staleB, pushed } =
        await layerCase(fixture, "layer-base-moved");

      await staleB();
      await layerSuccess(
        "rebased feat/b onto feat/a, run the standing checks, then skills restack-layer --push",
      );

      const rebasedB = await git(["rev-parse", "feat/b"]);
      await tip("feat/b", rebasedB, state.oldB);
      await tip("feat/c", state.oldC);

      await git(["checkout", "--quiet", "feat/a"]);
      await appendFile(join(state.repo, "a"), "another a change\n");
      await commit("feat/a", "fix: a moves again", ["a"]);

      await git(["checkout", "--quiet", "feat/b"]);

      await refusal(
        "feat/b is still stale on feat/a, run skills restack-layer without --push",
        "--push",
      );

      await tip("feat/b", rebasedB, state.oldB);
      await tip("feat/c", state.oldC);

      await layerSuccess(
        "rebased feat/b onto feat/a, run the standing checks, then skills restack-layer --push",
      );

      const secondB = await git(["rev-parse", "feat/b"]);
      expect(secondB).not.toBe(rebasedB);

      await tip("feat/b", secondB, state.oldB);
      await tip("feat/c", state.oldC);
      expect(await config("branch.feat/b.skills-restack-lease")).toBe(state.oldB);

      await layerSuccess("pushed feat/b\nrebased feat/c and pushed", "--push");
      await pushed();
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("layer-current", async () => {
    const fixture = await stackCase("skills-restack-layer-", { assertNoGhCalls: true });
    try {
      const { state, index, git, layerSuccess, unchanged } = await layerCase(
        fixture,
        "layer-current",
      );

      await git(["checkout", "--quiet", "feat/b"]);
      state.oldB = await git(["rev-parse", "feat/b"]);
      state.oldC = await git(["rev-parse", "feat/c"]);

      for (const args of [[], ["--push"]]) {
        await layerSuccess("feat/b already sits on feat/a", ...args);
        await unchanged();
      }

      await appendFile(join(state.repo, "b"), "dirty\n");
      await writeFile(
        index,
        (await readFile(index, "utf8")).replace("3\t-\t-\t-", "3\t-\tDOING\t-"),
      );

      for (const args of [[], ["--push"]]) {
        await layerSuccess("feat/b already sits on feat/a", ...args);
        await unchanged();
      }
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("layer-upper-conflict", async () => {
    const fixture = await stackCase("skills-restack-layer-", { assertNoGhCalls: true });
    try {
      const {
        state,
        git,
        run,
        commit,
        holderAt,
        holderState,
        tip,
        layerSuccess,
        refusal,
        config,
        unchanged,
        conflict,
        resolveRound,
      } = await layerCase(fixture, "layer-upper-conflict");

      await git(["checkout", "--quiet", "feat/c"]);
      await appendFile(join(state.repo, "round"), "c change\n");

      await commit("feat/c", "feat: c edits round", ["round"]);
      await git(["checkout", "--quiet", "feat/a"]);
      state.oldB = await git(["rev-parse", "feat/b"]);

      state.oldC = await git(["rev-parse", "feat/c"]);
      const holder = await holderAt("layer-held-c");
      const before = await holderState(holder);

      await appendFile(join(state.repo, "round"), "a change\n");

      const fixed = await run(fixRound, ["-P", "Proj", "-m", "fix: guard empty input", "round"]);
      const reason =
        "fix-round: rebase conflict on feat/c onto feat/b, restack feat/b first, row 2 of Proj, held by no checkout, the round is pushed on feat/a, every layer above it is untouched";

      expect(fixed.code, fixed.stderr).toBe(1);

      expect(fixed.stdout).toBe("");
      expect(fixed.stderr.split("\n")).toContain(reason);
      await unchanged();

      expect(await holderState(holder)).toEqual(before);

      await git(["checkout", "--quiet", "feat/b"]);
      await layerSuccess(
        "rebased feat/b onto feat/a, run the standing checks, then skills restack-layer --push",
      );

      const rebasedB = await git(["rev-parse", "feat/b"]);

      await tip("feat/b", rebasedB, state.oldB);
      await tip("feat/c", state.oldC);
      const rejected = await refusal(
        `rebase conflict on feat/c onto feat/b, row 3 of Proj, held by ${holder}, feat/b is pushed, every layer above it is untouched`,
        "--push",
      );

      expect(rejected.stderr.trimEnd()).toBe(
        `restack-layer: rebase conflict on feat/c onto feat/b, row 3 of Proj, held by ${holder}, feat/b is pushed, every layer above it is untouched`,
      );

      await tip("feat/b", rebasedB);
      await tip("feat/c", state.oldC);

      expect(await config("branch.feat/b.skills-restack-lease")).toBe("");
      expect(await holderState(holder)).toEqual(before);

      state.repo = holder;
      await conflict("feat/c", "feat/b", state.oldC);
      await tip("feat/b", rebasedB);

      await tip("feat/c", state.oldC);
      await resolveRound();
      const rebasedC = await git(["rev-parse", "feat/c"]);

      await tip("feat/c", rebasedC, state.oldC);
      await layerSuccess("pushed feat/c", "--push");
      await tip("feat/b", rebasedB);

      await tip("feat/c", rebasedC);
      await git(["merge-base", "--is-ancestor", "feat/b", "feat/c"]);
      expect(await config("branch.feat/c.skills-restack-lease")).toBe("");
    } finally {
      await fixture.dispose();
    }
  });
});

test.concurrent("wrapper uses the case cwd and environment", async () => {
  const fixture = await stackCase("skills-restack-layer-wrapper-", { assertNoGhCalls: true });
  try {
    const { index, holderAt } = await layerCase(fixture, "wrapper");
    const holder = await holderAt("t3code-0000");
    await rm(index);

    const result = await fixture.command([bin, "restack-layer", "-P", "Proj"], holder);
    expect([result.code, result.stdout, result.stderr]).toEqual([
      1,
      "",
      "restack-layer: no index.tsv for Proj\n",
    ]);
  } finally {
    await fixture.dispose();
  }
});

test.concurrent("usage wrapper", async () => {
  const fixture = await stackCase("skills-restack-layer-wrapper-", { assertNoGhCalls: true });
  try {
    const result = await fixture.command([bin, "restack-layer"], fixture.temporary);
    expect([result.code, result.stdout, result.stderr]).toEqual([2, "", `usage: ${usage}\n`]);
  } finally {
    await fixture.dispose();
  }
});

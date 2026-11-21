import { expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { appendFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { commitFixture, fixtureGit, writeFixture } from "./fixtures.ts";
import { removeTemporary } from "./process.ts";
import { publishRepo, startCloseRepo } from "./repo-fixtures.ts";
import type { RepoLayout } from "./repo-template.ts";
import { stackCase, stackRepo, threeLayerStack, type StackCase } from "./stack-fixture.ts";

const headRefs = ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"];

type Copy = Awaited<ReturnType<typeof stackRepo>>;

function inside(directory: string, path: string): boolean {
  const offset = relative(directory, path);
  return offset !== "" && !offset.startsWith("..");
}

async function refs(copy: Copy): Promise<{ local: string; origin: string }> {
  return {
    local: await copy.git(headRefs),
    origin: await copy.git([`--git-dir=${copy.origin}`, ...headRefs]),
  };
}

test.concurrent("each copy of one template keeps its own origin, hooks and worktrees", async () => {
  const fixtures: StackCase[] = [];
  try {
    const spec = threeLayerStack("copies");
    async function copy(): Promise<Copy> {
      const fixture = await stackCase("skills-stack-fixture-");
      fixtures.push(fixture);
      return stackRepo(fixture, spec);
    }

    const one = await copy();
    const two = await copy();
    for (const [index, copied] of [one, two].entries()) {
      const url = await copied.git(["config", "remote.origin.url"]);
      const hooks = await copied.git(["config", "core.hooksPath"]);
      expect(url).toBe(copied.origin);
      expect(inside(fixtures[index]!.temporary, url)).toBe(true);
      expect(inside(fixtures[index]!.temporary, hooks)).toBe(true);
    }

    const fresh = await refs(two);
    const marker = join(fixtures[0]!.temporary, "hook-ran");
    await fixtures[0]!.executable(
      join(one.repo, ".git/hooks/pre-push"),
      `#!/bin/sh\nprintf '%s\\n' "$PWD" >> "${marker}"\n`,
    );

    await appendFile(join(one.repo, "a"), "pushed from the first copy\n");
    const pushed = await one.commit("feat/a", "fix: a moves", ["a"]);
    expect(await one.git([`--git-dir=${one.origin}`, "rev-parse", "feat/a"])).toBe(pushed);
    expect(existsSync(marker)).toBe(true);

    const holder = await one.holderAt("held", "feat/c");
    expect(await one.git(["worktree", "list", "--porcelain"])).toContain(`worktree ${holder}\n`);

    expect(await refs(two)).toEqual(fresh);
    expect(await two.git(["worktree", "list", "--porcelain"])).not.toContain(holder);

    const runs = await Bun.file(marker).text();
    await two.git(["checkout", "--quiet", "feat/b"]);
    await appendFile(join(two.repo, "b"), "pushed from the second copy\n");
    await two.commit("feat/b", "fix: b moves", ["b"]);
    expect(await Bun.file(marker).text()).toBe(runs);

    const three = await copy();
    expect(await refs(three)).toEqual(fresh);
    expect(existsSync(join(three.repo, ".git/hooks/pre-push"))).toBe(false);
    expect(await three.git(["worktree", "list", "--porcelain"])).toBe(
      `worktree ${three.repo}\nHEAD ${await three.git(["rev-parse", "HEAD"])}\nbranch refs/heads/feat/a`,
    );
  } finally {
    for (const fixture of fixtures) await fixture.dispose();
  }
});

async function repoState(copy: RepoLayout, directory: string) {
  const read = async (cwd: string, args: readonly string[]) =>
    (await fixtureGit(cwd, args)).replaceAll(directory, "<copy>");

  return {
    local: await read(copy.repo, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    origin: await read(copy.origin, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    config: await read(copy.repo, ["config", "--local", "--list"]),
    tree: await read(copy.repo, ["status", "--porcelain", "--branch"]),
  };
}

test.concurrent.each([
  ["publish", "repo", (copy: RepoLayout) => publishRepo(copy, "feat/a.b+c")],
  ["start-close", "fixture", startCloseRepo],
] as const)(
  "each copy of the %s template keeps its own commits, branches and config",
  async (_, name, make) => {
    const directories: string[] = [];
    try {
      async function copy(): Promise<{ directory: string; layout: RepoLayout }> {
        const directory = realpathSync(await mkdtemp(join(tmpdir(), "skills-repo-fixture-")));
        directories.push(directory);

        const layout = { repo: join(directory, name), origin: join(directory, "origin.git") };
        await make(layout);
        return { directory, layout };
      }

      const one = await copy();
      const two = await copy();
      for (const { directory, layout } of [one, two]) {
        const url = (await fixtureGit(layout.repo, ["config", "remote.origin.url"])).trimEnd();
        const hooks = await fixtureGit(layout.repo, ["rev-parse", "--git-path", "hooks"]);
        expect(url).toBe(layout.origin);
        expect(inside(directory, resolve(layout.repo, hooks.trimEnd()))).toBe(true);
      }

      const fresh = await repoState(two.layout, two.directory);
      expect(fresh.config).not.toMatch(/=\//);
      expect(await repoState(one.layout, one.directory)).toEqual(fresh);

      await fixtureGit(one.layout.repo, ["checkout", "--quiet", "-b", "feat/first-copy"]);
      await fixtureGit(one.layout.repo, ["config", "branch.feat/first-copy.note", "first"]);
      await writeFixture(one.layout.repo, "first-copy", "first\n");
      await commitFixture(one.layout.repo);
      await fixtureGit(one.layout.repo, ["push", "--quiet", "origin", "feat/first-copy"]);

      const pushed = await fixtureGit(one.layout.origin, [
        "rev-parse",
        "refs/heads/feat/first-copy",
      ]);

      expect(pushed).toBe(await fixtureGit(one.layout.repo, ["rev-parse", "HEAD"]));
      expect(await repoState(one.layout, one.directory)).not.toEqual(fresh);
      expect(await repoState(two.layout, two.directory)).toEqual(fresh);

      const three = await copy();
      expect(await repoState(three.layout, three.directory)).toEqual(fresh);
    } finally {
      for (const directory of directories) await removeTemporary(directory);
    }
  },
);

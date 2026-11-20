import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join, relative } from "node:path";
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

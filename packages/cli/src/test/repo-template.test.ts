import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { removeTemporary } from "./process.ts";
import { copyTemplate, repoTemplate, type RepoLayout } from "./repo-template.ts";

test("a template is built once per git environment and shape, under the preload scratch", async () => {
  const roots: string[] = [];
  async function build(root: string): Promise<RepoLayout> {
    roots.push(root);
    return { repo: join(root, "repo"), origin: join(root, "origin.git") };
  }

  const keyed = randomUUID();
  const env = { GIT_AUTHOR_NAME: "one", HOME: "/first" };
  const built = await repoTemplate(env, [keyed, 1], build);
  expect(await repoTemplate({ ...env, HOME: "/second" }, [keyed, 1], build)).toBe(built);
  expect(roots).toHaveLength(1);

  const shaped = await repoTemplate(env, [keyed, 2], build);
  const identified = await repoTemplate({ ...env, GIT_AUTHOR_NAME: "two" }, [keyed, 1], build);
  expect(new Set([built.repo, shaped.repo, identified.repo]).size).toBe(3);

  const scratch = realpathSync(process.env.PLANS_SCRATCH ?? "");
  expect(roots.map((root) => dirname(root))).toEqual([scratch, scratch, scratch]);
});

test("a failed build is tried again by the next caller", async () => {
  let builds = 0;
  async function build(root: string): Promise<RepoLayout> {
    builds += 1;
    if (builds === 1) throw new Error("the first build fails");
    return { repo: join(root, "repo"), origin: join(root, "origin.git") };
  }

  const retried = randomUUID();
  await expect(repoTemplate({}, [retried], build)).rejects.toThrow("the first build fails");

  const built = await repoTemplate({}, [retried], build);
  expect(await repoTemplate({}, [retried], build)).toBe(built);
  expect(builds).toBe(2);
});

test("a copy whose config still names its template is refused", async () => {
  const template = await repoTemplate({}, [randomUUID()], async (root) => {
    const repo = join(root, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(join(repo, ".git/config"), `[core]\n\thooksPath = ${repo}/.git/hooks\n`);
    return { repo, origin: join(root, "origin.git") };
  });

  const directory = realpathSync(await mkdtemp(join(tmpdir(), "skills-repo-template-test-")));
  try {
    const kept = { repo: join(directory, "kept"), origin: join(directory, "kept.git") };
    await expect(copyTemplate(template, kept, async () => {}, "default")).rejects.toThrow(
      `${kept.repo} still points at its template`,
    );

    const pinned = { repo: join(directory, "pinned"), origin: join(directory, "pinned.git") };
    await copyTemplate(
      template,
      pinned,
      ([, key, value], cwd) => writeFile(join(cwd, ".git/config"), `${key} = ${value}\n`),
      "pinned",
    );

    expect(await Bun.file(join(pinned.repo, ".git/config")).text()).toBe(
      `core.hooksPath = ${pinned.repo}/.git/hooks\n`,
    );
  } finally {
    await removeTemporary(directory);
  }
});

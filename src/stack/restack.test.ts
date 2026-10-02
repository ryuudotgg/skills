import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fixtureGit, writeFixture } from "../test/fixtures.ts";
import { removeTemporary, runCommand, suiteEnvironment } from "../test/process.ts";

const bin = resolve(import.meta.dir, "../../skills/playbook/bin/skills");
const original = "dir with space/café notes.txt";
const renamed = "nouveau dossier/naïve ü.txt";
let temporary: string;
let origin: string;
let repo: string;
let env: NodeJS.ProcessEnv;

async function git(args: readonly string[], cwd = repo): Promise<string> {
  return (await fixtureGit(cwd, args)).trimEnd();
}

async function commit(branch: string, message: string): Promise<string> {
  await git(["add", "-A"]);
  await git(["-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
  await git(["push", "-q", "origin", branch]);

  return git(["rev-parse", branch]);
}

async function leaseRebase(...args: string[]) {
  return runCommand([bin, "lease-rebase", ...args], { cwd: repo, env, timeout: 60_000 });
}

async function tree(ref: string, cwd = repo): Promise<string[]> {
  return (await fixtureGit(cwd, ["ls-tree", "-r", "-z", "--name-only", ref]))
    .split("\0")
    .filter(Boolean);
}

beforeEach(async () => {
  temporary = realpathSync(await mkdtemp(join(tmpdir(), "skills-restack-")));
  origin = join(temporary, "origin.git");
  repo = join(temporary, "repo");
  env = {
    ...suiteEnvironment(),
    SKILLS_CONF: join(temporary, "skills.conf"),
    PLANS_DIR: join(temporary, "plans"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "skills test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "skills test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };

  await writeFile(env.SKILLS_CONF ?? "", "DELIVERY=prs\n");
  await git(["init", "-q", "--bare", "-b", "main", origin], temporary);
  await git(["clone", "-q", origin, repo], temporary);

  await writeFixture(repo, original, "one\ntwo\nthree\n");
  await writeFixture(repo, "shared", "base\n");
  await commit("main", "chore: initial files");

  await git(["checkout", "-q", "-b", "a"]);
  await writeFixture(repo, "a", "a\n");
  await commit("a", "feat: a");
}, 30_000);

afterEach(async () => {
  await removeTemporary(temporary);
});

describe("lease-rebase", () => {
  test("restacks a layer that renames a path with a space and a non ASCII character", async () => {
    const oldA = await git(["rev-parse", "a"]);

    await git(["checkout", "-q", "-b", "b"]);
    await mkdir(join(repo, dirname(renamed)));
    await git(["mv", original, renamed]);
    await appendFile(join(repo, renamed), "four\n");
    const oldB = await commit("b", "feat: rename notes");

    await git(["checkout", "-q", "-b", "c"]);
    await writeFixture(repo, "c", "c\n");
    const oldC = await commit("c", "feat: c");

    await git(["checkout", "-q", "a"]);
    await appendFile(join(repo, "a"), "fix\n");
    const newA = await commit("a", "fix: a");
    await git(["checkout", "-q", "main"]);

    const holder = join(temporary, "held c");
    await git(["worktree", "add", "-q", holder, "c"]);
    await appendFile(join(repo, ".git/info/exclude"), "ignorée/\n");
    await writeFixture(holder, "ignorée/état.txt", "kept\n");

    const result = await leaseRebase("a", oldA, "b", "c");
    expect([result.code, result.stderr]).toEqual([0, ""]);

    const newB = await git(["rev-parse", "b"]);
    const newC = await git(["rev-parse", "c"]);
    expect(result.stdout).toBe(`b ${oldB} ${newB}\nc ${oldC} ${newC}\n`);

    for (const branch of ["b", "c"])
      expect(await git(["rev-parse", `refs/heads/${branch}`], origin)).toBe(
        await git(["rev-parse", branch]),
      );

    expect(await git(["rev-parse", "b~1"])).toBe(newA);
    expect(await git(["rev-parse", "c~1"])).toBe(newB);
    expect(await tree("b")).toEqual(["a", renamed, "shared"].sort());
    expect(await tree("c")).toEqual(["a", "c", renamed, "shared"].sort());

    expect(await git(["diff", "-M", "a", "b"])).toBe(await git(["diff", "-M", oldA, oldB]));
    expect(await git(["show", `c:${renamed}`])).toBe("one\ntwo\nthree\nfour");

    expect(await git(["rev-parse", "HEAD"], holder)).toBe(newC);
    expect(await readFile(join(holder, renamed), "utf8")).toBe("one\ntwo\nthree\nfour\n");
    expect(await readFile(join(holder, "ignorée/état.txt"), "utf8")).toBe("kept\n");
  }, 60_000);

  test("refuses when an ignored directory with a space and a non ASCII name holds where the move adds a file", async () => {
    const oldA = await git(["rev-parse", "a"]);

    await git(["checkout", "-q", "-b", "b"]);
    await writeFixture(repo, "b", "b\n");
    const oldB = await commit("b", "feat: b");

    await git(["checkout", "-q", "a"]);
    await writeFixture(repo, renamed, "incoming\n");
    await commit("a", "fix: add notes");
    await git(["checkout", "-q", "main"]);

    const holder = join(temporary, "held b");
    await git(["worktree", "add", "-q", holder, "b"]);
    await appendFile(join(repo, ".git/info/exclude"), "nouveau dossier/\n");
    await writeFixture(holder, renamed, "operator notes\n");

    const result = await leaseRebase("a", oldA, "b");
    expect([result.code, result.stdout, result.stderr]).toEqual([
      1,
      "",
      `lease-rebase: b is held by ${holder} and an ignored file sits where the move adds one\n`,
    ]);

    expect(await git(["rev-parse", "b"])).toBe(oldB);
    expect(await git(["rev-parse", "refs/heads/b"], origin)).toBe(oldB);
    expect(await readFile(join(holder, renamed), "utf8")).toBe("operator notes\n");
  }, 60_000);
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProject } from "../project.ts";
import { captureIo, fixtureGit, fixtureGitEnv } from "../test/fixtures.ts";
import { removeTemporary, runCommand } from "../test/process.ts";
import { bindVerb } from "./bind.ts";

const usage = "skills plans bind <Project> | --clear";

let temporary: string;
let plans: string;
let repo: string;

const io = (cwd = repo) => captureIo({ ...fixtureGitEnv(), PLANS_DIR: plans }, cwd);

async function pinLines(cwd = repo): Promise<string> {
  const read = await runCommand(["git", "config", "--local", "--get-regexp", "^skills\\."], {
    cwd,
    env: fixtureGitEnv(),
    timeout: 30_000,
  });

  expect(read.timedOut).toBe(false);
  expect(read.code === 0 || (read.code === 1 && read.stdout === "" && read.stderr === "")).toBe(
    true,
  );

  return read.stdout;
}

beforeEach(async () => {
  temporary = await realpath(await mkdtemp(join(tmpdir(), "skills-bind-")));
  plans = join(temporary, "plans");
  repo = join(temporary, "web");

  await mkdir(join(plans, "Demo"), { recursive: true });
  await mkdir(join(plans, "Other"));

  await mkdir(repo);
  await fixtureGit(repo, ["init", "-q", "-b", "main"]);
  await fixtureGit(repo, ["remote", "add", "fork", "https://example.com/acme/fork"]);
  await fixtureGit(repo, ["remote", "add", "origin", "git@example.com:Acme/Web.git"]);
});

afterEach(async () => {
  await removeTemporary(temporary);
});

test("binds the checkout to the project in its directory's casing, keyed on origin", async () => {
  const run = io();

  expect(await bindVerb(["demo"], usage, run)).toBe(0);
  expect(run.stdout).toBe(`bound ${repo} to Demo\n`);
  expect(await pinLines()).toBe("skills.project Demo\nskills.repo example.com/acme/web\n");
  expect(await detectProject(repo, plans, true, io())).toBe("Demo");

  expect(await bindVerb(["Other"], usage, io())).toBe(0);
  expect(await pinLines()).toBe("skills.project Other\nskills.repo example.com/acme/web\n");
});

test("an unkeyed origin falls back to the first keyed remote, printed as $PWD spells it", async () => {
  await fixtureGit(repo, ["remote", "set-url", "origin", "/srv/web.git"]);
  await fixtureGit(repo, ["remote", "add", "early", "/srv/early.git"]);
  await fixtureGit(repo, ["remote", "add", "later", "https://example.com/acme/later"]);

  const spelled = join(temporary, "spelled");
  await symlink(temporary, spelled);

  const run = captureIo({ ...fixtureGitEnv(), PLANS_DIR: plans, PWD: join(spelled, "web") }, repo);
  expect(await bindVerb(["Demo"], usage, run)).toBe(0);
  expect(run.stdout).toBe(`bound ${join(spelled, "web")} to Demo\n`);
  expect(await pinLines()).toBe("skills.project Demo\nskills.repo example.com/acme/fork\n");
});

test("a rebind replaces every value either key holds", async () => {
  for (const [key, value] of [
    ["skills.project", "Old"],
    ["skills.project", "Older"],
    ["skills.repo", "example.com/acme/old"],
    ["skills.repo", "example.com/acme/older"],
  ] as const)
    await fixtureGit(repo, ["config", "--local", "--add", key, value]);

  expect(await bindVerb(["Demo"], usage, io())).toBe(0);
  expect(await pinLines()).toBe("skills.project Demo\nskills.repo example.com/acme/web\n");
});

test("a checkout with no keyed remote gets a pin and no pin key", async () => {
  await fixtureGit(repo, ["config", "--local", "skills.repo", "example.com/acme/old"]);
  await fixtureGit(repo, ["remote", "remove", "fork"]);
  await fixtureGit(repo, ["remote", "set-url", "origin", "/srv/web.git"]);

  expect(await bindVerb(["Demo"], usage, io())).toBe(0);
  expect(await pinLines()).toBe("skills.project Demo\n");
});

test("an unknown project and a folder outside git refuse and change nothing", async () => {
  await bindVerb(["Demo"], usage, io());
  const before = await pinLines();

  const unknown = io();
  expect(await bindVerb(["Nope"], usage, unknown)).toBe(1);
  expect(unknown.stderr).toBe(`bind: no project Nope under ${plans}\n`);
  expect(await pinLines()).toBe(before);

  const outside = io(temporary);
  expect(await bindVerb(["Demo"], usage, outside)).toBe(1);
  expect(outside.stderr).toStartWith("bind: not inside a git repository");
});

test("--clear from a linked worktree removes the shared pin, and again is a no-op", async () => {
  await fixtureGit(repo, ["commit", "-q", "--allow-empty", "-m", "root"]);
  await bindVerb(["Demo"], usage, io());

  const side = join(temporary, "side");
  await fixtureGit(repo, ["worktree", "add", "-q", side, "-b", "feat/side"]);

  const cleared = io(side);
  expect(await bindVerb(["--clear"], usage, cleared)).toBe(0);
  expect(cleared.stdout).toBe(`unbound ${side}\n`);
  expect(await pinLines()).toBe("");
  expect(await bindVerb(["--clear"], usage, io(side))).toBe(0);
});

test("a failed write refuses naming the config file", async () => {
  const config = join(repo, ".git/config");
  await mkdir(`${config}.lock`);

  const run = io();
  expect(await bindVerb(["Demo"], usage, run)).toBe(1);
  expect(run.stderr).toStartWith(`bind: cannot write ${config}: `);
});

test.each([[[]], [["Demo", "Other"]], [["--force"]]])("%p is a usage error", async (args) => {
  const run = io();
  expect(await bindVerb(args, usage, run)).toBe(2);
  expect(run.stderr).toBe(`usage: ${usage}\n`);
});

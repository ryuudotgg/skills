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

async function round(...files: string[]): Promise<CommandResult> {
  return command([bin, "fix-round", "-P", "Proj", "-m", "fix: guard empty input", ...(files.length ? files : ["round"])]);
}

async function refusal(reason: string, argv?: readonly string[], cwd = repo): Promise<CommandResult> {
  const result = argv ? await command(argv, cwd) : await round();
  expect(result.code, result.stderr).toBe(1);
  expect(result.stderr).toContain(reason);
  expect(result.stdout).toBe("");
  return result;
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

async function holderAt(name: string, branch = "feat/c"): Promise<string> {
  const holder = join(temporary, name);
  await git(["worktree", "add", "--quiet", holder, branch]);
  return realpathSync(holder);
}

async function holderState(holder: string): Promise<{ head: string; tree: string }> {
  return { head: await git(["rev-parse", "HEAD"], holder), tree: await git(["status", "--porcelain"], holder) };
}

async function tip(branch: string, local: string, remote = local): Promise<void> {
  expect(await git(["rev-parse", branch])).toBe(local);
  expect(await git([`--git-dir=${origin}`, "rev-parse", branch])).toBe(remote);
}

async function upperUnchanged(oldB: string, oldC: string): Promise<void> {
  await tip("feat/b", oldB);
  await tip("feat/c", oldC);
  await tip("feat/a", await git(["rev-parse", "feat/a"]));
  expect(await git(["branch", "--show-current"])).toBe("feat/a");
}

async function executable(path: string, source: string): Promise<void> {
  await writeFixture(temporary, path, source);
  await chmod(join(temporary, path), 0o755);
}

async function doing(): Promise<void> {
  await writeFile(index, (await readFile(index, "utf8")).replace("3\t-\t-\t-", "3\t-\tDOING\t-"));
}

beforeEach(async () => {
  temporary = realpathSync(await mkdtemp(join(tmpdir(), "skills-fix-round-")));
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

afterEach(async () => {
  try {
    expect(await readFile(join(temporary, "gh.log"), "utf8")).toBe("");
  } finally {
    await removeTemporary(temporary);
  }
});

describe("fix-round legacy cases", () => {
  test("happy", async () => {
    await fresh("happy");
    const oldA = await git(["rev-parse", "feat/a"]);
    await appendFile(join(repo, "round"), "round change\n");

    const result = await round();
    expect(result.code, result.stderr).toBe(0);

    for (const branch of ["feat/a", "feat/b", "feat/c"]) await tip(branch, await git(["rev-parse", branch]));
    expect(await git(["rev-parse", "feat/a^"])).toBe(oldA);
    await git(["merge-base", "--is-ancestor", "feat/a", "feat/b"]);
    await git(["merge-base", "--is-ancestor", "feat/b", "feat/c"]);
    expect(await git(["rev-list", "--count", "feat/a..feat/b"])).toBe("1");
    expect(await git(["rev-list", "--count", "feat/b..feat/c"])).toBe("1");
    expect(await git(["branch", "--show-current"])).toBe("feat/a");
    expect(result.stdout).toBe(`committed ${await git(["rev-parse", "--short", "HEAD"])} on feat/a\npushed feat/a\nrebased feat/b and pushed\nrebased feat/c and pushed\n`);
  }, 60_000);

  test("hands-off", async () => {
    await fresh("hands-off");
    await writeFile(join(temporary, "skills.conf"), "DELIVERY=hands-off\n");
    await appendFile(join(repo, "round"), "change\n");

    await refusal("fix-round: delivery mode is not prs");
  }, 60_000);

  for (const [name, branch, reason] of [
    ["unowned-current", "feat/a", "feat/a is not an owned branch"],
    ["unowned-layer", "feat/b", "feat/b above feat/a is not an owned branch"],
  ] as const)
    test(name, async () => {
      await fresh(name);
      await writeFile(index, (await readFile(index, "utf8")).split("\n").filter((line) => !line.includes(branch)).join("\n"));
      await appendFile(join(repo, "round"), "change\n");

      await refusal(`fix-round: ${reason}`);
    }, 60_000);

  test("two-children", async () => {
    await fresh("two-children");
    await git(["branch", "feat/other", "feat/a"]);
    await git(["config", "branch.feat/other.skills-base", "feat/a"]);
    await appendFile(join(repo, "round"), "change\n");

    await refusal("fix-round: two layers above feat/a: feat/b feat/other");
  }, 60_000);

  test("nothing", async () => {
    await fresh("nothing");
    await refusal("fix-round: nothing to commit for this round");
  }, 60_000);

  test("staged", async () => {
    await fresh("staged");
    await appendFile(join(repo, "round"), "change\n");
    await writeFixture(repo, "outside", "outside\n");
    await git(["add", "--", "outside"]);

    await refusal("fix-round: already staged outside the file list: outside");
  }, 60_000);

  for (const [name, branch, reason] of [
    ["remote-layer", "feat/b", "origin/feat/b differs from feat/b, sync it first"],
    ["remote-current", "feat/a", "origin/feat/a has commits feat/a lacks"],
  ] as const)
    test(name, async () => {
      await fresh(name);
      await git(["checkout", "--quiet", branch]);
      await git(["commit", "--quiet", "--allow-empty", "-m", "feat: remote"]);
      await git(["push", "--quiet", "origin", branch]);
      await git(["reset", "--quiet", "--hard", "HEAD^"]);
      await git(["checkout", "--quiet", "feat/a"]);
      await appendFile(join(repo, "round"), "change\n");

      await refusal(`fix-round: ${reason}`);
    }, 60_000);

  for (const name of ["conflict", "upper-conflict"])
    test(name, async () => {
      await fresh(name);
      const upper = name === "upper-conflict";
      const branch = upper ? "feat/c" : "feat/b";
      await git(["checkout", "--quiet", branch]);
      await appendFile(join(repo, "round"), upper ? "c change\n" : "b change\n");
      await commit(branch, `feat: ${upper ? "c" : "b"} edits round`, ["round"]);
      await git(["checkout", "--quiet", "feat/a"]);
      const oldB = await git(["rev-parse", "feat/b"]);
      const oldC = await git(["rev-parse", "feat/c"]);
      const holder = upper ? await holderAt("held-conflict") : undefined;
      const before = holder ? await holderState(holder) : undefined;
      await appendFile(join(repo, "round"), "a change\n");

      const reason = `fix-round: rebase conflict on ${branch} onto ${upper ? "feat/b, restack feat/b first" : "feat/a"}, row 2 of Proj, held by no checkout, the round is pushed on feat/a, every layer above it is untouched`;
      const result = await refusal(reason);
      expect(result.stderr.split("\n")).toContain(reason);
      await upperUnchanged(oldB, oldC);
      expect(existsSync(join(repo, ".git/rebase-merge"))).toBe(false);
      expect(existsSync(join(repo, ".git/rebase-apply"))).toBe(false);
      expect(await git(["status", "--porcelain"])).toBe("");
      if (holder && before) expect(await holderState(holder)).toEqual(before);
    }, 60_000);

  test("deletion", async () => {
    await fresh("deletion");
    await git(["rm", "--quiet", "--", "a"]);

    const result = await command([bin, "fix-round", "-P", "Proj", "-m", "fix: drop stale file", "a"]);
    expect(result.code, result.stderr).toBe(0);
    expect((await command(["git", `--git-dir=${origin}`, "cat-file", "-e", "feat/a:a"])).code).not.toBe(0);
    await tip("feat/c", await git(["rev-parse", "feat/c"]));
  }, 60_000);

  test("unreadable-remote", async () => {
    await fresh("unreadable-remote");
    const realGit = (await succeed(["sh", "-c", "command -v git"])).stdout.trimEnd();
    await executable("flaky-bin/git", `#!/bin/sh\n[ "$1 $2" = 'ls-remote --exit-code' ] && exit 128\nexec "${realGit}" "$@"\n`);
    env.PATH = `${temporary}/flaky-bin:${env.PATH}`;
    await appendFile(join(repo, "round"), "change\n");

    await refusal("fix-round: cannot read origin/feat/a");
  }, 60_000);

  test("unpublished", async () => {
    await fresh("unpublished");
    await git(["branch", "-D", "--quiet", "feat/c"]);
    await git(["checkout", "--quiet", "-b", "feat/d", "feat/a"]);
    await git(["config", "branch.feat/b.skills-base", "feat/d"]);
    await appendFile(index, "4\t-\t-\t-\t-\t-\t-\tfeat/d\n");
    await appendFile(join(repo, "round"), "change\n");

    await refusal("fix-round: origin has no feat/d, publish it first");
  }, 60_000);

  test("held-layer", async () => {
    await fresh("held-layer");
    const oldB = await git(["rev-parse", "feat/b"]);
    const holder = await holderAt("held", "feat/b");
    await writeFixture(holder, "untracked", "stray\n");
    await appendFile(join(repo, "round"), "change\n");

    const result = await round();
    expect(result.code, result.stderr).toBe(0);
    const newB = await git(["rev-parse", "feat/b"]);
    expect(newB).not.toBe(oldB);
    await tip("feat/b", newB);
    expect(await git(["rev-parse", "HEAD"], holder)).toBe(newB);
    expect(await git(["status", "--porcelain", "--untracked-files=no"], holder)).toBe("");
    expect(await readFile(join(holder, "untracked"), "utf8")).toBe("stray\n");
    expect(await git(["branch", "--show-current"])).toBe("feat/a");
    expect(await git(["rev-parse", "feat/b^"])).toBe(await git(["rev-parse", "feat/a"]));
  }, 60_000);

  test("doing-layer", async () => {
    await fresh("doing-layer");
    const oldA = await git([`--git-dir=${origin}`, "rev-parse", "feat/a"]);
    await doing();
    await appendFile(join(repo, "round"), "change\n");

    await refusal("fix-round: row 3 is DOING on feat/c");
    expect(await git([`--git-dir=${origin}`, "rev-parse", "feat/a"])).toBe(oldA);
  }, 60_000);

  for (const busy of ["tracked", "rebase", "deleted", "doing"])
    test(`busy-${busy}`, async () => {
      await fresh(`busy-${busy}`);
      const holder = await holderAt(`held-${busy}`);

      let reason = holder;
      if (busy === "tracked") await appendFile(join(holder, "c"), "dirty\n");
      else if (busy === "rebase") expect((await command(["git", "rebase", "--exec", "false", "HEAD^"], holder)).code).not.toBe(0);
      else if (busy === "deleted") await rm(holder, { recursive: true });
      else {
        await doing();
        env.SKILLS_OWN_ROWS = "feat/c";
        reason = "row 3 is DOING on feat/c";
      }

      await appendFile(join(repo, "round"), "change\n");
      const before = await branches();
      const heldBefore = existsSync(holder) ? await holderState(holder) : undefined;
      await refusal(reason);
      expect(await branches()).toEqual(before);
      if (heldBefore) expect(await holderState(holder)).toEqual(heldBefore);
    }, 60_000);

  test("lease_race", async () => {
    await fresh("lease_race");
    const oldB = await git(["rev-parse", "feat/b"]);
    const oldC = await git(["rev-parse", "feat/c"]);
    const holder = await holderAt("held-race");
    const before = await holderState(holder);
    const racer = join(temporary, "racer");
    const realGit = (await succeed(["sh", "-c", "command -v git"])).stdout.trimEnd();
    await git(["clone", "--quiet", origin, racer], temporary);
    await executable("lease_race/Proj/.git/hooks/pre-push", `#!/bin/sh
case $(cat) in
  *refs/heads/feat/c*)
    cd "${racer}"
    "${realGit}" checkout --quiet feat/c
    printf 'race\\n' >> c
    "${realGit}" commit --quiet -am 'fix: race'
    "${realGit}" push --quiet origin feat/c
    ;;
esac
`);

    await appendFile(join(repo, "round"), "change\n");

    await refusal("lease push rejected, the round is pushed on feat/a, every layer above it is untouched");
    await tip("feat/b", oldB);
    await tip("feat/c", oldC, await git(["rev-parse", "feat/c"], racer));
    await tip("feat/a", await git(["rev-parse", "feat/a"]));
    expect(await holderState(holder)).toEqual(before);
  }, 60_000);

  test("holder-busy-after-push", async () => {
    await fresh("holder-busy-after-push");
    const oldB = await git(["rev-parse", "feat/b"]);
    const oldC = await git(["rev-parse", "feat/c"]);
    const holder = await holderAt("held-after-push");
    await executable("holder-busy-after-push/Proj/.git/hooks/pre-push", `#!/bin/sh
case $(cat) in
  *refs/heads/feat/c*)
    if [ ! -f "${temporary}/busy-hook-ran" ]; then
      printf 'busy\\n' >> "${holder}/c"
      touch "${temporary}/busy-hook-ran"
    fi
    ;;
esac
`);

    await appendFile(join(repo, "round"), "change\n");

    const result = await round();
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain(`fix-round: cannot move feat/c: feat/c is held by ${holder} with tracked changes`);
    const newB = await git(["rev-parse", "feat/b"]);
    expect(newB).not.toBe(oldB);
    expect(await git(["rev-parse", "feat/b^"])).toBe(await git(["rev-parse", "feat/a"]));
    await tip("feat/b", newB);
    await tip("feat/c", oldC);
    expect(await git(["rev-parse", "HEAD"], holder)).toBe(oldC);
    expect(await readFile(join(holder, "c"), "utf8")).toBe("c1\nbusy\n");
    expect(result.stdout).toBe(`committed ${await git(["rev-parse", "--short", "HEAD"])} on feat/a\npushed feat/a\nrebased feat/b and pushed\n`);
  }, 60_000);

  test("no-ref-action", async () => {
    await fresh("no-ref-action");
    const realGit = (await succeed(["sh", "-c", "command -v git"])).stdout.trimEnd();
    await executable("old-bin/git", `#!/bin/sh
if [ "$1 $2" = 'replay -h' ]; then
  echo 'usage: git replay --onto <revision> <range>'
  exit 129
fi
exec "${realGit}" "$@"
`);

    env.PATH = `${temporary}/old-bin:${env.PATH}`;
    await appendFile(join(repo, "round"), "change\n");
    const before = await branches();

    await refusal("git replay lacks --ref-action");
    expect(await branches()).toEqual(before);
  }, 60_000);

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

    await refusal("fix-round: this checkout is other, not a checkout of fixture", [bin, "fix-round", "-P", "fixture", "-m", "fix: guard empty input", "round"]);
    expect(await branches()).toEqual(before);
    expect(await git(["ls-remote", "origin"])).toBe(remote);
  }, 60_000);

  test("matching worktree without index", async () => {
    await fresh("matching-worktree");
    const holder = await holderAt("t3code-0000");
    await rm(index);

    const result = await refusal("fix-round: no index.tsv for Proj", [bin, "fix-round", "-P", "Proj", "-m", "fix: guard empty input", "round"], holder);
    expect(result.stderr).not.toContain("not a checkout of");
  }, 60_000);

  test("subdirectory staged deletion", async () => {
    await fresh("subdirectory-deletion");
    await writeFixture(repo, "nested/stale", "stale\n");
    await commit("feat/a", "feat: stale file", ["nested/stale"]);
    await git(["rm", "--quiet", "--", "nested/stale"]);
    await mkdir(join(repo, "nested"), { recursive: true });

    const result = await command([bin, "fix-round", "-PProj", "-mfix: drop stale file", "--", "stale"], join(repo, "nested"));
    expect(result.code, result.stderr).toBe(0);
    expect((await command(["git", `--git-dir=${origin}`, "cat-file", "-e", "feat/a:nested/stale"])).code).not.toBe(0);
    await tip("feat/c", await git(["rev-parse", "feat/c"]));
  }, 60_000);

  test("getopts usage", async () => {
    await fresh("getopts-usage");
    for (const args of [[], ["-P", "Proj", "round"], ["-P", "Proj", "-PProj", "-mfix: x", "round"], ["-PProj", "-mfix: x", "-mfix: y", "round"], ["-PProj", "-m"], ["--push"]]) {
      const result = await command([bin, "fix-round", ...args]);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe('usage: skills fix-round -P <Project> -m "<message>" <file>...\n');
    }
  }, 60_000);

  test("recorded base cycle", async () => {
    await fresh("base-cycle");
    await git(["config", "branch.feat/a.skills-base", "feat/c"]);
    await appendFile(join(repo, "round"), "change\n");
    const before = await branches();

    await refusal("fix-round: cycle in recorded bases at feat/a");
    expect(await branches()).toEqual(before);
  }, 60_000);

  test("failed branch push", async () => {
    await fresh("failed-branch-push");
    await executable("failed-branch-push/Proj/.git/hooks/pre-push", "#!/bin/sh\nexit 1\n");
    const oldB = await git(["rev-parse", "feat/b"]);
    const oldC = await git(["rev-parse", "feat/c"]);
    const remoteA = await git([`--git-dir=${origin}`, "rev-parse", "feat/a"]);
    await appendFile(join(repo, "round"), "change\n");

    const oldA = await git(["rev-parse", "feat/a"]);
    const failed = await refusal("fix-round: git push failed");
    expect(failed.stderr.split("\n")).toContain("fix-round: git push failed");
    expect(await git(["rev-parse", "feat/a^"])).toBe(oldA);
    expect(await git(["log", "-1", "--format=%s", "feat/a"])).toBe("fix: guard empty input");
    await tip("feat/b", oldB);
    await tip("feat/c", oldC);
    expect(await git([`--git-dir=${origin}`, "rev-parse", "feat/a"])).toBe(remoteA);
  }, 60_000);

  for (const collision of ["untracked", "ignored", "ignored-dir"])
    test(`holder-${collision}`, async () => {
      await fresh(`holder-${collision}`);
      const oldB = await git(["rev-parse", "feat/b"]);
      const oldC = await git(["rev-parse", "feat/c"]);
      const holder = await holderAt(`collision-${collision}`);
      await writeFixture(holder, collision === "ignored-dir" ? "incoming/private" : "incoming", "stray\n");
      if (collision !== "untracked") await appendFile(join(repo, ".git/info/exclude"), "incoming\n");

      const before = await holderState(holder);
      await writeFixture(repo, "incoming", "incoming\n");
      await appendFile(join(repo, "round"), "change\n");
      if (collision !== "untracked") await git(["add", "-f", "--", "incoming"]);

      const result = await round("incoming", "round");
      const reason = collision === "untracked"
        ? `feat/c is held by ${holder} and its files block the move`
        : `feat/c is held by ${holder} and an ignored file sits where the move adds one`;

      expect(result.code, result.stderr).toBe(1);
      expect(result.stderr).toContain(reason);
      expect(result.stdout).toBe("");
      await upperUnchanged(oldB, oldC);
      expect(await holderState(holder)).toEqual(before);
    }, 60_000);
});

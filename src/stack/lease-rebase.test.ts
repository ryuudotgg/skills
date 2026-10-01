import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fixtureGit, writeFixture } from "../test/fixtures.ts";
import { removeTemporary, runCommand, suiteEnvironment } from "../test/process.ts";
import type { CommandResult } from "../test/process.ts";

const bin = resolve(import.meta.dir, "../../skills/playbook/bin/skills");
let temporary: string;
let origin: string;
let repo: string;
let env: NodeJS.ProcessEnv;
let original: string;
let oldA: string;
let oldB: string;
let oldC: string;

async function git(args: readonly string[], cwd = repo): Promise<string> {
  return (await fixtureGit(cwd, args)).trimEnd();
}

async function command(argv: readonly string[], cwd = repo): Promise<CommandResult> {
  const result = await runCommand(argv, { cwd, env, timeout: 60_000 });
  expect(result.timedOut).toBe(false);
  return result;
}

async function succeed(argv: readonly string[], cwd = repo): Promise<string> {
  const result = await command(argv, cwd);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trimEnd();
}

async function commit(branch: string, message: string, paths: string[], cwd = repo): Promise<string> {
  await git(["add", "--", ...paths], cwd);
  await succeed(["git", "commit", "--quiet", "-m", message], cwd);
  await git(["push", "--quiet", "origin", branch], cwd);

  return git(["rev-parse", branch], cwd);
}

async function fresh(caseName: string, shared = "base"): Promise<void> {
  origin = join(temporary, `${caseName}.git`);
  repo = join(temporary, caseName);
  original = "main";

  await writeFile(join(temporary, "skills.conf"), "DELIVERY=prs\n");
  await git(["init", "--quiet", "--bare", "-b", "main", origin], temporary);
  await git(["clone", "--quiet", origin, repo], temporary);

  await git(["config", "commit.gpgsign", "false"]);
  await git(["config", "core.hooksPath", join(repo, ".git/hooks")]);
  await writeFixture(repo, "shared", `${shared}\n`);
  await commit("main", "chore: initial files", ["shared"]);

  await git(["checkout", "--quiet", "-b", "a"]);
  await writeFixture(repo, "a", "a\n");
  oldA = await commit("a", "feat: a", ["a"]);
}

async function stack(): Promise<void> {
  await git(["checkout", "--quiet", "-b", "b"]);
  await writeFixture(repo, "shared", "b\n");
  oldB = await commit("b", "feat: b", ["shared"]);

  await git(["checkout", "--quiet", "-b", "c"]);
  await writeFixture(repo, "c", "c\n");
  oldC = await commit("c", "feat: c", ["c"]);

  await git(["checkout", "--quiet", original]);
}

async function fixParent(): Promise<void> {
  await git(["checkout", "--quiet", "a"]);
  await appendFile(join(repo, "a"), "fix\n");
  await commit("a", "fix: a", ["a"]);

  await git(["checkout", "--quiet", original]);
}

async function expectRestored(): Promise<void> {
  expect(await git(["symbolic-ref", "--quiet", "--short", "HEAD"])).toBe(original);

  for (const state of ["rebase-merge", "rebase-apply"]) {
    const path = await git(["rev-parse", "--git-path", state]);
    expect(existsSync(resolve(repo, path))).toBe(false);
  }
}

async function expectClean(): Promise<void> {
  await expectRestored();
  expect(await git(["status", "--porcelain"])).toBe("");
}

async function expectTip(branch: string, local: string, remote: string): Promise<void> {
  expect(await git(["rev-parse", `refs/heads/${branch}`])).toBe(local);
  expect(await git([`--git-dir=${origin}`, "rev-parse", `refs/heads/${branch}`])).toBe(remote);
}

async function expectRebased(branch: string, old: string, parent: string, count: number): Promise<void> {
  const tip = await git(["rev-parse", `refs/heads/${branch}`]);
  expect(tip).not.toBe(old);

  await expectTip(branch, tip, tip);
  expect(await git(["rev-parse", `${branch}~${count}`])).toBe(await git(["rev-parse", parent]));
}

async function rebaseStack(...args: string[]): Promise<CommandResult> {
  const result = await command([bin, "lease-rebase", ...args]);
  expect(result.code, result.stderr).toBe(0);

  await expectClean();

  return result;
}

async function refusal(reason: string, ...args: string[]): Promise<CommandResult> {
  const result = await command([bin, "lease-rebase", ...args]);
  expect(result.code, result.stderr).toBe(1);
  expect(result.stderr.split("\n")).toContain(`lease-rebase: ${reason}`);

  await expectRestored();

  return result;
}

async function expectRefusal(reason: string, ...args: string[]): Promise<void> {
  const refs = ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"];
  const localBefore = await git(refs);
  const remoteBefore = await git([`--git-dir=${origin}`, ...refs]);
  const treeBefore = await git(["status", "--porcelain"]);

  const result = await refusal(reason, ...args);
  expect(result.stdout).toBe("");

  expect(await git(refs)).toBe(localBefore);
  expect(await git([`--git-dir=${origin}`, ...refs])).toBe(remoteBefore);
  expect(await git(["status", "--porcelain"])).toBe(treeBefore);
}

async function snapshotHolder(holder: string): Promise<{ head: string; tree: string }> {
  const head = await git(["rev-parse", "HEAD"], holder);
  const tree = await git(["status", "--porcelain"], holder);
  return { head, tree };
}

async function expectHolderUnchanged(holder: string, before: { head: string; tree: string }): Promise<void> {
  expect(await git(["rev-parse", "HEAD"], holder)).toBe(before.head);
  expect(await git(["status", "--porcelain"], holder)).toBe(before.tree);
}

async function holderAt(name: string): Promise<string> {
  const holder = join(temporary, name);
  await git(["worktree", "add", "--quiet", holder, "c"]);
  return realpathSync(holder);
}

async function executable(path: string, source: string): Promise<void> {
  await writeFixture(temporary, path, source);
  await chmod(join(temporary, path), 0o755);
}

async function chainOutput(): Promise<string> {
  const newB = await git(["rev-parse", "b"]);
  const newC = await git(["rev-parse", "c"]);
  return `b ${oldB} ${newB}\nc ${oldC} ${newC}\n`;
}

async function signingKey(): Promise<void> {
  const key = join(temporary, "signing-key");
  await succeed(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", key]);

  const publicKey = (await readFile(`${key}.pub`, "utf8")).trimEnd();
  await writeFile(join(temporary, "allowed-signers"), `test@example.com ${publicKey}\n`);

  await git(["config", "gpg.format", "ssh"]);
  await git(["config", "user.signingkey", key]);
  await git(["config", "commit.gpgsign", "true"]);
}

beforeEach(async () => {
  temporary = realpathSync(await mkdtemp(join(tmpdir(), "skills-lease-rebase-")));
  env = {
    ...suiteEnvironment(),
    SKILLS_CONF: join(temporary, "skills.conf"),
    PLANS_DIR: join(temporary, "plans"),
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
  };

  delete env.SKILLS_OWN_ROWS;
});

afterEach(async () => {
  await removeTemporary(temporary);
});

describe("lease-rebase legacy cases", () => {
  test("chain", async () => {
    await fresh("chain");
    await stack();
    await fixParent();
    const newA = await git(["rev-parse", "a"]);

    const result = await rebaseStack("a", oldA, "b", "c");
    await expectRebased("b", oldB, "a", 1);
    await expectRebased("c", oldC, "b", 1);
    await expectTip("a", newA, newA);

    expect(result.stdout).toBe(await chainOutput());
  }, 60_000);

  test("update_refs", async () => {
    await fresh("update_refs");
    await stack();
    await git(["config", "rebase.updateRefs", "true"]);
    await git(["branch", "bystander", oldB]);
    await fixParent();

    await rebaseStack("a", oldA, "b", "c");
    expect(await git(["rev-parse", "bystander"])).toBe(oldB);
  }, 60_000);

  test("on_listed_branch", async () => {
    await fresh("on_listed_branch");
    await stack();
    await fixParent();

    original = "b";
    await git(["checkout", "--quiet", "b"]);

    await rebaseStack("a", oldA, "b", "c");
    await expectRebased("b", oldB, "a", 1);
    await expectRebased("c", oldC, "b", 1);
  }, 60_000);

  test("untracked_collision", async () => {
    await fresh("untracked_collision");
    await stack();
    await fixParent();
    await writeFixture(repo, "c", "stray\n");

    await expectRefusal("dirty tree", "a", oldA, "b", "c");
    expect(await readFile(join(repo, "c"), "utf8")).toBe("stray\n");

    await rm(join(repo, "c"));
  }, 60_000);

  test("lease_race", async () => {
    await fresh("lease_race");
    await stack();
    await fixParent();
    const holder = await holderAt("held-race");
    const before = await snapshotHolder(holder);

    const racer = join(temporary, "racer");
    await git(["clone", "--quiet", origin, racer], temporary);
    await executable("lease_race/.git/hooks/pre-push", `#!/bin/sh
case $(cat) in
  *refs/heads/c*)
    cd "${racer}"
    git checkout --quiet c
    printf 'race\\n' >> c
    git commit --quiet -am 'fix: race'
    git push --quiet origin c
    ;;
esac
`);

    const result = await refusal("lease push rejected, no layer moved", "a", oldA, "b", "c");
    const raced = await git(["rev-parse", "c"], racer);
    await expectTip("c", oldC, raced);
    await expectTip("b", oldB, oldB);

    expect(result.stdout).toBe("");
    await expectHolderUnchanged(holder, before);
    await expectClean();
  }, 60_000);

  test("context", async () => {
    await fresh("context", "context\none\ntwo\nbase\nfour\nfive\nsix");
    await git(["checkout", "--quiet", "-b", "b"]);
    await writeFixture(repo, "shared", "context\none\ntwo\nb first\nfour\nfive\nsix\n");
    await git(["add", "--", "shared"]);
    await succeed(["git", "commit", "--quiet", "-m", "feat: first b change"]);

    await writeFixture(repo, "shared", "context\none\ntwo\nb second\nfour\nfive\nsix\n");
    oldB = await commit("b", "feat: second b change", ["shared"]);

    await git(["checkout", "--quiet", "-b", "c"]);
    await writeFixture(repo, "c", "c\n");
    oldC = await commit("c", "feat: c", ["c"]);

    await git(["checkout", "--quiet", "a"]);
    await writeFixture(repo, "shared", "fixed context\none\ntwo\nbase\nfour\nfive\nsix\n");
    await commit("a", "fix: b context", ["shared"]);

    await succeed(["git", "rebase", "--quiet", "--onto", "a", oldA, "b"]);
    const plain = await command(["git", "rebase", "--quiet", "b", "c"]);
    expect(plain.code).not.toBe(0);

    await succeed(["git", "rebase", "--abort"]);
    await git(["checkout", "--quiet", "b"]);
    await git(["reset", "--quiet", "--hard", oldB]);
    await git(["checkout", "--quiet", original]);

    const result = await rebaseStack("a", oldA, "b", "c");
    await expectRebased("b", oldB, "a", 2);
    await expectRebased("c", oldC, "b", 1);

    expect(await git(["show", "c:shared"])).toBe("fixed context\none\ntwo\nb second\nfour\nfive\nsix");
    expect(result.stdout).toBe(await chainOutput());
  }, 60_000);

  test("squash", async () => {
    await fresh("squash");
    await stack();
    await git(["merge", "--quiet", "--squash", "a"]);
    await succeed(["git", "commit", "--quiet", "-m", "feat: squash a"]);

    await git(["push", "--quiet", "origin", "main"]);
    await git(["fetch", "--quiet", "origin"]);
    const newMain = await git(["rev-parse", "origin/main"]);

    const result = await rebaseStack("origin/main", oldA, "b");
    await expectRebased("b", oldB, "origin/main", 1);
    await expectTip("main", newMain, newMain);

    const retained = await command(["git", "merge-base", "--is-ancestor", oldA, "b"]);
    expect(retained.code).not.toBe(0);
    expect(result.stdout).toBe(`b ${oldB} ${await git(["rev-parse", "b"])}\n`);
  }, 60_000);

  test("conflict", async () => {
    await fresh("conflict");
    await stack();
    await git(["checkout", "--quiet", "a"]);
    await writeFixture(repo, "shared", "conflicting fix\n");
    await commit("a", "fix: shared line", ["shared"]);

    await git(["checkout", "--quiet", original]);
    await expectRefusal(`rebase conflict on b onto a, held by no checkout, then restack-layer.sh --onto a ${oldA}`, "a", oldA, "b");

    await expectTip("b", oldB, oldB);
    await expectClean();
  }, 60_000);

  test("remote-ahead", async () => {
    await fresh("remote-ahead");
    await stack();
    await fixParent();
    const operator = join(temporary, "operator");

    await git(["clone", "--quiet", origin, operator], temporary);
    await git(["checkout", "--quiet", "b"], operator);
    await writeFixture(operator, "operator", "operator\n");
    const remoteB = await commit("b", "feat: operator change", ["operator"], operator);

    await expectRefusal("origin/b has commits b lacks", "a", oldA, "b", "c");
    await expectTip("b", oldB, remoteB);
    await expectClean();
  }, 60_000);

  test("hands-off", async () => {
    await fresh("hands-off");
    await stack();
    await writeFile(join(temporary, "skills.conf"), "DELIVERY=hands-off\n");

    await expectRefusal("delivery mode is not prs", "a", oldA, "b");
    await expectClean();
  }, 60_000);

  test("trunk", async () => {
    await fresh("trunk");
    await stack();
    await fixParent();

    await expectRefusal("cannot rebase the default branch main", "a", oldA, "b", "main");
    await expectClean();
  }, 60_000);

  test("dirty", async () => {
    await fresh("dirty");
    await stack();
    await appendFile(join(repo, "shared"), "dirty\n");

    await expectRefusal("dirty tree", "a", oldA, "b");
    expect(await readFile(join(repo, "shared"), "utf8")).toBe("base\ndirty\n");

    await git(["checkout", "--", "shared"]);
    await expectClean();
  }, 60_000);

  test("unpublished", async () => {
    await fresh("unpublished");
    await stack();
    await fixParent();
    await git(["branch", "unpublished", "c"]);

    await expectRefusal("unpublished is not on origin", "a", oldA, "b", "unpublished");
    await expectClean();
  }, 60_000);

  test("worktree", async () => {
    await fresh("worktree");
    await stack();
    await fixParent();
    const holder = await holderAt("other-worktree");
    await writeFixture(holder, "untracked", "stray\n");

    await rebaseStack("a", oldA, "b", "c");
    await expectRebased("b", oldB, "a", 1);
    await expectRebased("c", oldC, "b", 1);

    expect(await git(["rev-parse", "HEAD"], holder)).toBe(await git(["rev-parse", "c"]));
    expect(await git(["status", "--porcelain", "--untracked-files=no"], holder)).toBe("");
    expect(await readFile(join(holder, "untracked"), "utf8")).toBe("stray\n");

    await expectClean();
  }, 60_000);

  test("partial", async () => {
    await fresh("partial");
    await git(["checkout", "--quiet", "-b", "b"]);
    await writeFixture(repo, "b", "b\n");
    oldB = await commit("b", "feat: b", ["b"]);

    await git(["checkout", "--quiet", "-b", "c"]);
    await writeFixture(repo, "shared", "c\n");
    oldC = await commit("c", "feat: c", ["shared"]);

    await git(["checkout", "--quiet", "a"]);
    await writeFixture(repo, "shared", "conflicting fix\n");
    await commit("a", "fix: shared line", ["shared"]);
    await git(["checkout", "--quiet", original]);

    const holder = await holderAt("held-conflict");
    const before = await snapshotHolder(holder);
    await expectRefusal(`rebase conflict on c onto b, restack b first, held by no checkout, then restack-layer.sh --onto a ${oldA}`, "a", oldA, "b", "c");

    await expectTip("b", oldB, oldB);
    await expectTip("c", oldC, oldC);
    await expectHolderUnchanged(holder, before);
    await expectClean();
  }, 60_000);

  for (const busy of ["tracked", "rebase", "deleted", "doing"] as const)
    test(`busy-${busy}`, async () => {
      await fresh(`busy-${busy}`);
      await stack();
      await fixParent();
      const holder = await holderAt(`held-${busy}`);

      let reason: string;
      switch (busy) {
        case "tracked":
          await appendFile(join(holder, "c"), "dirty\n");
          reason = `c is held by ${holder} with tracked changes`;
          break;

        case "rebase": {
          const paused = await command(["git", "rebase", "--exec", "false", "HEAD^"], holder);
          expect(paused.code).not.toBe(0);

          reason = `c is held by ${holder} with rebase-merge in progress`;
          break;
        }

        case "deleted":
          await rm(holder, { recursive: true, force: true });
          reason = `c is held by ${holder} and its directory is gone`;
          break;

        case "doing": {
          const index = join(temporary, "plans/Proj/index.tsv");
          await writeFixture(temporary, "plans/Proj/index.tsv", "id\ta\tstatus\tc\td\te\tf\tbranch\n3\t-\tDOING\t-\t-\t-\t-\tc\n");

          reason = `row 3 in ${index} is DOING on c, held by ${holder}`;
          break;
        }
      }

      const before = existsSync(holder) ? await snapshotHolder(holder) : undefined;
      await expectRefusal(reason, "a", oldA, "b", "c");

      if (before)
        await expectHolderUnchanged(holder, before);

      if (busy === "tracked")
        expect(await readFile(join(holder, "c"), "utf8")).toBe("c\ndirty\n");

      if (busy === "doing") {
        env.SKILLS_OWN_ROWS = "b c";
        await rebaseStack("a", oldA, "b", "c");
        await expectRebased("b", oldB, "a", 1);
        await expectRebased("c", oldC, "b", 1);

        expect(await git(["rev-parse", "HEAD"], holder)).toBe(await git(["rev-parse", "c"]));
        expect(await git(["status", "--porcelain", "--untracked-files=no"], holder)).toBe("");
      }
    }, 60_000);

  for (const collision of ["untracked", "ignored"] as const)
    test(`holder-${collision}`, async () => {
      await fresh(`holder-${collision}`);
      await stack();
      await git(["checkout", "--quiet", "a"]);
      await writeFixture(repo, "incoming", "incoming\n");

      await commit("a", "fix: add incoming", ["incoming"]);
      await git(["checkout", "--quiet", original]);
      const holder = await holderAt(`collision-${collision}`);
      await writeFixture(holder, "incoming", "stray\n");

      if (collision === "ignored")
        await appendFile(join(repo, ".git/info/exclude"), "incoming\n");

      const reason = collision === "ignored"
        ? `c is held by ${holder} and an ignored file sits where the move adds one`
        : `c is held by ${holder} and its files block the move`;

      const before = await snapshotHolder(holder);

      await expectRefusal(reason, "a", oldA, "b", "c");
      await expectHolderUnchanged(holder, before);
      expect(await readFile(join(holder, "incoming"), "utf8")).toBe("stray\n");
    }, 60_000);

  test("holder-busy-after-push", async () => {
    await fresh("holder-busy-after-push");
    await stack();
    await fixParent();
    const holder = await holderAt("held-after-push");

    await executable("holder-busy-after-push/.git/hooks/pre-push", `#!/bin/sh
if [ ! -f "${temporary}/busy-hook-ran" ]; then
  printf 'busy\\n' >> "${holder}/c"
  touch "${temporary}/busy-hook-ran"
fi
`);

    const result = await refusal(`cannot move c: c is held by ${holder} with tracked changes`, "a", oldA, "b", "c");
    await expectRebased("b", oldB, "a", 1);
    await expectTip("c", oldC, oldC);

    expect(await git(["rev-parse", "HEAD"], holder)).toBe(oldC);
    expect(await readFile(join(holder, "c"), "utf8")).toBe("c\nbusy\n");
    expect(result.stdout).toBe(`b ${oldB} ${await git(["rev-parse", "b"])}\n`);

    await expectClean();
  }, 60_000);

  test("holder-commit-race", async () => {
    await fresh("holder-commit-race");
    await stack();
    await fixParent();
    const holder = await holderAt("held-commit-race");
    const realGit = await succeed(["sh", "-c", "command -v git"]);

    await executable("race-bin/git", `#!/bin/sh
case "$*" in
  *"--work-tree=${holder} reset --quiet --keep"*)
    if [ ! -f "${temporary}/commit-hook-ran" ]; then
      "${realGit}" -C "${holder}" commit --quiet --allow-empty -m 'fix: raced commit'
      "${realGit}" -C "${holder}" rev-parse HEAD > "${temporary}/raced-tip"
      touch "${temporary}/commit-hook-ran"
    fi
    ;;
esac
exec "${realGit}" "$@"
`);

    env.PATH = `${temporary}/race-bin:${env.PATH}`;
    const result = await refusal(`cannot move c: c moved in holder ${holder} during the restack`, "a", oldA, "b", "c");
    const racedTip = (await readFile(join(temporary, "raced-tip"), "utf8")).trimEnd();

    await expectRebased("b", oldB, "a", 1);
    await expectTip("c", racedTip, oldC);

    expect(await git(["rev-parse", "HEAD"], holder)).toBe(racedTip);
    expect(await git(["status", "--porcelain"], holder)).toBe("");
    expect(result.stdout).toBe(`b ${oldB} ${await git(["rev-parse", "b"])}\n`);

    await expectClean();
  }, 60_000);

  test("signed", async () => {
    await fresh("signed");
    await signingKey();
    await git(["config", "gpg.ssh.allowedSignersFile", join(temporary, "allowed-signers")]);
    await stack();
    await fixParent();

    const newA = await git(["rev-parse", "a"]);
    const oldBAuthor = await git(["log", "-1", "--format=%an %ae %ad %B", oldB]);

    await rebaseStack("a", oldA, "b", "c");
    await expectRebased("b", oldB, "a", 1);
    await expectRebased("c", oldC, "b", 1);
    await expectTip("a", newA, newA);

    expect(await git(["log", "--format=%G?", `${newA}..c`])).toBe("G\nG");
    expect(await git(["log", "-1", "--format=%an %ae %ad %B", "b"])).toBe(oldBAuthor);
    expect(await git(["diff", "a", "b"])).toBe(await git(["diff", oldA, oldB]));
  }, 60_000);

  test("signed_header", async () => {
    await fresh("signed_header");
    await signingKey();
    await stack();

    oldC = await succeed(["sh", "-c", `git cat-file commit c | awk '/^committer /{ print; print "change-id abc"; next } 1' | git hash-object -t commit -w --stdin`]);

    await git(["branch", "-f", "c", oldC]);
    await git(["push", "--quiet", "--force", "origin", "c"]);
    await fixParent();

    await expectRefusal("cannot sign c: a replayed commit carries a change-id header", "a", oldA, "b", "c");
  }, 60_000);

  test("no-ref-action", async () => {
    await fresh("no-ref-action");
    await stack();
    await fixParent();
    const realGit = await succeed(["sh", "-c", "command -v git"]);

    await executable("old-bin/git", `#!/bin/sh
if [ "$1 $2" = 'replay -h' ]; then
  echo 'usage: git replay --onto <revision> <range>'
  exit 129
fi
exec "${realGit}" "$@"
`);

    env.PATH = `${temporary}/old-bin:${env.PATH}`;
    await expectRefusal("git replay lacks --ref-action", "a", oldA, "b", "c");
  }, 60_000);
});

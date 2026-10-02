import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeFixture } from "../test/fixtures.ts";
import type { CommandResult } from "../test/process.ts";
import { stackCase, stackRepo, type StackCase, type StackVerb } from "../test/stack-fixture.ts";
import { leaseRebaseVerb } from "./lease-rebase.ts";

setDefaultTimeout(60_000);

const bin = resolve(import.meta.dir, "../../skills/playbook/bin/skills");
const root = resolve(import.meta.dir, "../../skills");
const usage = "skills lease-rebase <parent> <parent-old-tip> <branch>...";
const leaseRebase: StackVerb = (args, io) => leaseRebaseVerb(args, usage, root, io);

async function leaseCase(fixture: StackCase, name: string, shared = "base") {
  const { temporary, env, executable } = fixture;
  const repository = await stackRepo(fixture, {
    name,
    commits: [
      { branch: "main", message: "chore: initial files", files: { shared: shared + "\n" } },
      { branch: "a", message: "feat: a", files: { a: "a\n" } },
    ],
    checkout: "a",
  });

  const { repo, origin, git, command, commit } = repository;
  const state = { original: "main", oldA: repository.tips.a!, oldB: "", oldC: "" };

  async function succeed(argv: readonly string[], cwd = repo): Promise<string> {
    const result = await command(argv, cwd);
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trimEnd();
  }

  async function stack(): Promise<void> {
    await repository.extend([
      { branch: "b", message: "feat: b", files: { shared: "b\n" } },
      { branch: "c", message: "feat: c", files: { c: "c\n" } },
    ], state.original);

    state.oldB = repository.tips.b!;
    state.oldC = repository.tips.c!;
  }

  async function fixParent(): Promise<void> {
    await git(["checkout", "--quiet", "a"]);
    await appendFile(join(repo, "a"), "fix\n");
    await commit("a", "fix: a", ["a"]);

    await git(["checkout", "--quiet", state.original]);
  }

  async function expectRestored(): Promise<void> {
    expect(await git(["symbolic-ref", "--quiet", "--short", "HEAD"])).toBe(state.original);

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
    const result = await repository.run(leaseRebase, args);
    expect(result.code, result.stderr).toBe(0);

    await expectClean();

    return result;
  }

  async function refusal(reason: string, ...args: string[]): Promise<CommandResult> {
    const result = await repository.run(leaseRebase, args);
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
    return repository.holderAt(name, "c");
  }

  async function chainOutput(): Promise<string> {
    const newB = await git(["rev-parse", "b"]);
    const newC = await git(["rev-parse", "c"]);
    return `b ${state.oldB} ${newB}\nc ${state.oldC} ${newC}\n`;
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

  return { temporary, env, repo, origin, state, git, command, succeed, commit, stack, fixParent, expectRestored, expectClean, expectTip, expectRebased, rebaseStack, refusal, expectRefusal, snapshotHolder, expectHolderUnchanged, holderAt, executable, chainOutput, signingKey };
}

describe("lease-rebase legacy cases", () => {
  test.concurrent("chain", async () => {
    const fixture = await stackCase("skills-lease-rebase-");
    try {
      const { state, git, stack, fixParent, expectTip, expectRebased, rebaseStack, chainOutput } = await leaseCase(fixture, "chain");
      await stack();
      await fixParent();
      const newA = await git(["rev-parse", "a"]);

      const result = await rebaseStack("a", state.oldA, "b", "c");
      await expectRebased("b", state.oldB, "a", 1);
      await expectRebased("c", state.oldC, "b", 1);
      await expectTip("a", newA, newA);

      expect(result.stdout).toBe(await chainOutput());
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("update_refs", async () => {
    const fixture = await stackCase("skills-lease-rebase-");
    try {
      const { state, git, stack, fixParent, rebaseStack } = await leaseCase(fixture, "update_refs");
      await stack();
      await git(["config", "rebase.updateRefs", "true"]);
      await git(["branch", "bystander", state.oldB]);
      await fixParent();

      await rebaseStack("a", state.oldA, "b", "c");
      expect(await git(["rev-parse", "bystander"])).toBe(state.oldB);
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("on_listed_branch", async () => {
    const fixture = await stackCase("skills-lease-rebase-");
    try {
      const { state, git, stack, fixParent, expectRebased, rebaseStack } = await leaseCase(fixture, "on_listed_branch");
      await stack();
      await fixParent();

      state.original = "b";
      await git(["checkout", "--quiet", "b"]);

      await rebaseStack("a", state.oldA, "b", "c");
      await expectRebased("b", state.oldB, "a", 1);
      await expectRebased("c", state.oldC, "b", 1);
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("untracked_collision", async () => {
    const fixture = await stackCase("skills-lease-rebase-");
    try {
      const { repo, state, stack, fixParent, expectRefusal } = await leaseCase(fixture, "untracked_collision");
      await stack();
      await fixParent();
      await writeFixture(repo, "c", "stray\n");

      await expectRefusal("dirty tree", "a", state.oldA, "b", "c");
      expect(await readFile(join(repo, "c"), "utf8")).toBe("stray\n");

      await rm(join(repo, "c"));
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("lease_race", async () => {
    const fixture = await stackCase("skills-lease-rebase-");
    try {
      const { origin, state, git, stack, fixParent, expectClean, expectTip, refusal, snapshotHolder, expectHolderUnchanged, holderAt, executable } = await leaseCase(fixture, "lease_race");
      await stack();
      await fixParent();
      const holder = await holderAt("held-race");
      const before = await snapshotHolder(holder);

      const racer = await fixture.clone(origin, "racer");
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

      const result = await refusal("lease push rejected, no layer moved", "a", state.oldA, "b", "c");
      const raced = await git(["rev-parse", "c"], racer);
      await expectTip("c", state.oldC, raced);
      await expectTip("b", state.oldB, state.oldB);

      expect(result.stdout).toBe("");
      await expectHolderUnchanged(holder, before);
      await expectClean();
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("context", async () => {
    const fixture = await stackCase("skills-lease-rebase-");
    try {
      const { repo, state, git, command, succeed, commit, expectRebased, rebaseStack, chainOutput } = await leaseCase(fixture, "context", "context\none\ntwo\nbase\nfour\nfive\nsix");
      await git(["checkout", "--quiet", "-b", "b"]);
      await writeFixture(repo, "shared", "context\none\ntwo\nb first\nfour\nfive\nsix\n");
      await git(["add", "--", "shared"]);
      await succeed(["git", "commit", "--quiet", "-m", "feat: first b change"]);

      await writeFixture(repo, "shared", "context\none\ntwo\nb second\nfour\nfive\nsix\n");
      state.oldB = await commit("b", "feat: second b change", ["shared"]);

      await git(["checkout", "--quiet", "-b", "c"]);
      await writeFixture(repo, "c", "c\n");
      state.oldC = await commit("c", "feat: c", ["c"]);

      await git(["checkout", "--quiet", "a"]);
      await writeFixture(repo, "shared", "fixed context\none\ntwo\nbase\nfour\nfive\nsix\n");
      await commit("a", "fix: b context", ["shared"]);

      await succeed(["git", "rebase", "--quiet", "--onto", "a", state.oldA, "b"]);
      const plain = await command(["git", "rebase", "--quiet", "b", "c"]);
      expect(plain.code).not.toBe(0);

      await succeed(["git", "rebase", "--abort"]);
      await git(["checkout", "--quiet", "b"]);
      await git(["reset", "--quiet", "--hard", state.oldB]);
      await git(["checkout", "--quiet", state.original]);

      const result = await rebaseStack("a", state.oldA, "b", "c");
      await expectRebased("b", state.oldB, "a", 2);
      await expectRebased("c", state.oldC, "b", 1);

      expect(await git(["show", "c:shared"])).toBe("fixed context\none\ntwo\nb second\nfour\nfive\nsix");
      expect(result.stdout).toBe(await chainOutput());
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("squash", async () => {
    const fixture = await stackCase("skills-lease-rebase-");
    try {
      const { state, git, command, succeed, stack, expectTip, expectRebased, rebaseStack } = await leaseCase(fixture, "squash");
      await stack();
      await git(["merge", "--quiet", "--squash", "a"]);
      await succeed(["git", "commit", "--quiet", "-m", "feat: squash a"]);

      await git(["push", "--quiet", "origin", "main"]);
      await git(["fetch", "--quiet", "origin"]);
      const newMain = await git(["rev-parse", "origin/main"]);

      const result = await rebaseStack("origin/main", state.oldA, "b");
      await expectRebased("b", state.oldB, "origin/main", 1);
      await expectTip("main", newMain, newMain);

      const retained = await command(["git", "merge-base", "--is-ancestor", state.oldA, "b"]);
      expect(retained.code).not.toBe(0);
      expect(result.stdout).toBe(`b ${state.oldB} ${await git(["rev-parse", "b"])}\n`);
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("conflict", async () => {
    const fixture = await stackCase("skills-lease-rebase-");
    try {
      const { repo, state, git, commit, stack, expectClean, expectTip, expectRefusal } = await leaseCase(fixture, "conflict");
      await stack();
      await git(["checkout", "--quiet", "a"]);
      await writeFixture(repo, "shared", "conflicting fix\n");
      await commit("a", "fix: shared line", ["shared"]);

      await git(["checkout", "--quiet", state.original]);
      await expectRefusal(`rebase conflict on b onto a, held by no checkout, then skills restack-layer --onto a ${state.oldA}`, "a", state.oldA, "b");

      await expectTip("b", state.oldB, state.oldB);
      await expectClean();
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("remote-ahead", async () => {
    const fixture = await stackCase("skills-lease-rebase-");
    try {
      const { origin, state, git, commit, stack, fixParent, expectClean, expectTip, expectRefusal } = await leaseCase(fixture, "remote-ahead");
      await stack();
      await fixParent();
      const operator = await fixture.clone(origin, "operator");

      await git(["checkout", "--quiet", "b"], operator);
      await writeFixture(operator, "operator", "operator\n");
      const remoteB = await commit("b", "feat: operator change", ["operator"], operator);

      await expectRefusal("origin/b has commits b lacks", "a", state.oldA, "b", "c");
      await expectTip("b", state.oldB, remoteB);
      await expectClean();
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("hands-off", async () => {
    const fixture = await stackCase("skills-lease-rebase-");
    try {
      const { temporary, state, stack, expectClean, expectRefusal } = await leaseCase(fixture, "hands-off");
      await stack();
      await writeFile(join(temporary, "skills.conf"), "DELIVERY=hands-off\n");

      await expectRefusal("delivery mode is not prs", "a", state.oldA, "b");
      await expectClean();
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("trunk", async () => {
    const fixture = await stackCase("skills-lease-rebase-");
    try {
      const { state, stack, fixParent, expectClean, expectRefusal } = await leaseCase(fixture, "trunk");
      await stack();
      await fixParent();

      await expectRefusal("cannot rebase the default branch main", "a", state.oldA, "b", "main");
      await expectClean();
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("dirty", async () => {
    const fixture = await stackCase("skills-lease-rebase-");
    try {
      const { repo, state, git, stack, expectClean, expectRefusal } = await leaseCase(fixture, "dirty");
      await stack();
      await appendFile(join(repo, "shared"), "dirty\n");

      await expectRefusal("dirty tree", "a", state.oldA, "b");
      expect(await readFile(join(repo, "shared"), "utf8")).toBe("base\ndirty\n");

      await git(["checkout", "--", "shared"]);
      await expectClean();
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("unpublished", async () => {
    const fixture = await stackCase("skills-lease-rebase-");
    try {
      const { state, git, stack, fixParent, expectClean, expectRefusal } = await leaseCase(fixture, "unpublished");
      await stack();
      await fixParent();
      await git(["branch", "unpublished", "c"]);

      await expectRefusal("unpublished is not on origin", "a", state.oldA, "b", "unpublished");
      await expectClean();
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("worktree", async () => {
    const fixture = await stackCase("skills-lease-rebase-");
    try {
      const { state, git, stack, fixParent, expectClean, expectRebased, rebaseStack, holderAt } = await leaseCase(fixture, "worktree");
      await stack();
      await fixParent();
      const holder = await holderAt("other-worktree");
      await writeFixture(holder, "untracked", "stray\n");

      await rebaseStack("a", state.oldA, "b", "c");
      await expectRebased("b", state.oldB, "a", 1);
      await expectRebased("c", state.oldC, "b", 1);

      expect(await git(["rev-parse", "HEAD"], holder)).toBe(await git(["rev-parse", "c"]));
      expect(await git(["status", "--porcelain", "--untracked-files=no"], holder)).toBe("");
      expect(await readFile(join(holder, "untracked"), "utf8")).toBe("stray\n");

      await expectClean();
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("partial", async () => {
    const fixture = await stackCase("skills-lease-rebase-");
    try {
      const { repo, state, git, commit, expectClean, expectTip, expectRefusal, snapshotHolder, expectHolderUnchanged, holderAt } = await leaseCase(fixture, "partial");
      await git(["checkout", "--quiet", "-b", "b"]);
      await writeFixture(repo, "b", "b\n");
      state.oldB = await commit("b", "feat: b", ["b"]);

      await git(["checkout", "--quiet", "-b", "c"]);
      await writeFixture(repo, "shared", "c\n");
      state.oldC = await commit("c", "feat: c", ["shared"]);

      await git(["checkout", "--quiet", "a"]);
      await writeFixture(repo, "shared", "conflicting fix\n");
      await commit("a", "fix: shared line", ["shared"]);
      await git(["checkout", "--quiet", state.original]);

      const holder = await holderAt("held-conflict");
      const before = await snapshotHolder(holder);
      await expectRefusal(`rebase conflict on c onto b, restack b first, held by no checkout, then skills restack-layer --onto a ${state.oldA}`, "a", state.oldA, "b", "c");

      await expectTip("b", state.oldB, state.oldB);
      await expectTip("c", state.oldC, state.oldC);
      await expectHolderUnchanged(holder, before);
      await expectClean();
    } finally {
      await fixture.dispose();
    }
  });

  for (const busy of ["tracked", "rebase", "deleted", "doing"] as const)
    test.concurrent(`busy-${busy}`, async () => {
      const fixture = await stackCase("skills-lease-rebase-");
      try {
        const { temporary, env, state, git, command, stack, fixParent, expectRebased, rebaseStack, expectRefusal, snapshotHolder, expectHolderUnchanged, holderAt } = await leaseCase(fixture, `busy-${busy}`);
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
        await expectRefusal(reason, "a", state.oldA, "b", "c");

        if (before)
          await expectHolderUnchanged(holder, before);

        if (busy === "tracked")
          expect(await readFile(join(holder, "c"), "utf8")).toBe("c\ndirty\n");

        if (busy === "doing") {
          env.SKILLS_OWN_ROWS = "b c";
          await rebaseStack("a", state.oldA, "b", "c");
          await expectRebased("b", state.oldB, "a", 1);
          await expectRebased("c", state.oldC, "b", 1);

          expect(await git(["rev-parse", "HEAD"], holder)).toBe(await git(["rev-parse", "c"]));
          expect(await git(["status", "--porcelain", "--untracked-files=no"], holder)).toBe("");
        }
      } finally {
        await fixture.dispose();
      }
    });

  for (const collision of ["untracked", "ignored"] as const)
    test.concurrent(`holder-${collision}`, async () => {
      const fixture = await stackCase("skills-lease-rebase-");
      try {
        const { repo, state, git, commit, stack, expectRefusal, snapshotHolder, expectHolderUnchanged, holderAt } = await leaseCase(fixture, `holder-${collision}`);
        await stack();
        await git(["checkout", "--quiet", "a"]);
        await writeFixture(repo, "incoming", "incoming\n");

        await commit("a", "fix: add incoming", ["incoming"]);
        await git(["checkout", "--quiet", state.original]);
        const holder = await holderAt(`collision-${collision}`);
        await writeFixture(holder, "incoming", "stray\n");

        if (collision === "ignored")
          await appendFile(join(repo, ".git/info/exclude"), "incoming\n");

        const reason = collision === "ignored"
          ? `c is held by ${holder} and an ignored file sits where the move adds one`
          : `c is held by ${holder} and its files block the move`;

        const before = await snapshotHolder(holder);

        await expectRefusal(reason, "a", state.oldA, "b", "c");
        await expectHolderUnchanged(holder, before);
        expect(await readFile(join(holder, "incoming"), "utf8")).toBe("stray\n");
      } finally {
        await fixture.dispose();
      }
    });

  test.concurrent("holder-busy-after-push", async () => {
    const fixture = await stackCase("skills-lease-rebase-");
    try {
      const { temporary, state, git, stack, fixParent, expectClean, expectTip, expectRebased, refusal, holderAt, executable } = await leaseCase(fixture, "holder-busy-after-push");
      await stack();
      await fixParent();
      const holder = await holderAt("held-after-push");

      await executable("holder-busy-after-push/.git/hooks/pre-push", `#!/bin/sh
if [ ! -f "${temporary}/busy-hook-ran" ]; then
  printf 'busy\\n' >> "${holder}/c"
  touch "${temporary}/busy-hook-ran"
fi
`);

      const result = await refusal(`cannot move c: c is held by ${holder} with tracked changes`, "a", state.oldA, "b", "c");
      await expectRebased("b", state.oldB, "a", 1);
      await expectTip("c", state.oldC, state.oldC);

      expect(await git(["rev-parse", "HEAD"], holder)).toBe(state.oldC);
      expect(await readFile(join(holder, "c"), "utf8")).toBe("c\nbusy\n");
      expect(result.stdout).toBe(`b ${state.oldB} ${await git(["rev-parse", "b"])}\n`);

      await expectClean();
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("holder-commit-race", async () => {
    const fixture = await stackCase("skills-lease-rebase-");
    try {
      const { temporary, env, state, git, succeed, stack, fixParent, expectClean, expectTip, expectRebased, refusal, holderAt, executable } = await leaseCase(fixture, "holder-commit-race");
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
      const result = await refusal(`cannot move c: c moved in holder ${holder} during the restack`, "a", state.oldA, "b", "c");
      const racedTip = (await readFile(join(temporary, "raced-tip"), "utf8")).trimEnd();

      await expectRebased("b", state.oldB, "a", 1);
      await expectTip("c", racedTip, state.oldC);

      expect(await git(["rev-parse", "HEAD"], holder)).toBe(racedTip);
      expect(await git(["status", "--porcelain"], holder)).toBe("");
      expect(result.stdout).toBe(`b ${state.oldB} ${await git(["rev-parse", "b"])}\n`);

      await expectClean();
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("signed", async () => {
    const fixture = await stackCase("skills-lease-rebase-");
    try {
      const { temporary, state, git, stack, fixParent, expectTip, expectRebased, rebaseStack, signingKey } = await leaseCase(fixture, "signed");
      await signingKey();
      await git(["config", "gpg.ssh.allowedSignersFile", join(temporary, "allowed-signers")]);
      await stack();
      await fixParent();

      const newA = await git(["rev-parse", "a"]);
      const oldBAuthor = await git(["log", "-1", "--format=%an %ae %ad %B", state.oldB]);

      await rebaseStack("a", state.oldA, "b", "c");
      await expectRebased("b", state.oldB, "a", 1);
      await expectRebased("c", state.oldC, "b", 1);
      await expectTip("a", newA, newA);

      expect(await git(["log", "--format=%G?", `${newA}..c`])).toBe("G\nG");
      expect(await git(["log", "-1", "--format=%an %ae %ad %B", "b"])).toBe(oldBAuthor);
      expect(await git(["diff", "a", "b"])).toBe(await git(["diff", state.oldA, state.oldB]));
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("signed_header", async () => {
    const fixture = await stackCase("skills-lease-rebase-");
    try {
      const { state, git, succeed, stack, fixParent, expectRefusal, signingKey } = await leaseCase(fixture, "signed_header");
      await signingKey();
      await stack();

      state.oldC = await succeed(["sh", "-c", `git cat-file commit c | awk '/^committer /{ print; print "change-id abc"; next } 1' | git hash-object -t commit -w --stdin`]);

      await git(["branch", "-f", "c", state.oldC]);
      await git(["push", "--quiet", "--force", "origin", "c"]);
      await fixParent();

      await expectRefusal("cannot sign c: a replayed commit carries a change-id header", "a", state.oldA, "b", "c");
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("no-ref-action", async () => {
    const fixture = await stackCase("skills-lease-rebase-");
    try {
      const { temporary, env, state, succeed, stack, fixParent, expectRefusal, executable } = await leaseCase(fixture, "no-ref-action");
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
      await expectRefusal("git replay lacks --ref-action", "a", state.oldA, "b", "c");
    } finally {
      await fixture.dispose();
    }
  });
});

test.concurrent("chain wrapper", async () => {
  const fixture = await stackCase("skills-lease-rebase-wrapper-");
  try {
    const { repo, state, git, command, stack, fixParent, expectClean, expectRebased, chainOutput } = await leaseCase(fixture, "chain-wrapper");
    await stack();
    await fixParent();

    const result = await command([bin, "lease-rebase", "a", state.oldA, "b", "c"], repo);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe(await chainOutput());

    await expectRebased("b", state.oldB, "a", 1);
    await expectRebased("c", state.oldC, "b", 1);
    await expectClean();
    expect(await git(["rev-parse", "a"])).not.toBe(state.oldA);
  } finally {
    await fixture.dispose();
  }
});

test.concurrent("usage wrapper", async () => {
  const fixture = await stackCase("skills-lease-rebase-wrapper-");
  try {
    const result = await fixture.command([bin, "lease-rebase"], fixture.temporary);
    expect([result.code, result.stdout, result.stderr]).toEqual([2, "", `usage: ${usage}\n`]);
  } finally {
    await fixture.dispose();
  }
});

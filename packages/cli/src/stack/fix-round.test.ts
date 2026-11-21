import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFile, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fixRound, fixRoundCase } from "../test/fix-round-fixture.ts";
import { writeFixture } from "../test/fixtures.ts";
import { editView } from "../test/plans-views.ts";
import {
  gitShim,
  oldReplayGit,
  stackCase,
  stackRepo,
  type StackCase,
} from "../test/stack-fixture.ts";

setDefaultTimeout(60_000);

describe("fix-round legacy cases", () => {
  test.concurrent("happy", async () => {
    const fixture = await stackCase("skills-fix-round-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      const { repo, git, round, tip } = await fixRoundCase(fixture, "happy");
      const oldA = await git(["rev-parse", "feat/a"]);
      await appendFile(join(repo, "round"), "round change\n");

      const result = await round();
      expect(result.code, result.stderr).toBe(0);

      for (const branch of ["feat/a", "feat/b", "feat/c"])
        await tip(branch, await git(["rev-parse", branch]));

      expect(await git(["rev-parse", "feat/a^"])).toBe(oldA);

      await git(["merge-base", "--is-ancestor", "feat/a", "feat/b"]);
      await git(["merge-base", "--is-ancestor", "feat/b", "feat/c"]);
      expect(await git(["rev-list", "--count", "feat/a..feat/b"])).toBe("1");
      expect(await git(["rev-list", "--count", "feat/b..feat/c"])).toBe("1");

      expect(await git(["branch", "--show-current"])).toBe("feat/a");
      expect(result.stdout).toBe(
        `committed ${await git(["rev-parse", "--short", "HEAD"])} on feat/a\npushed feat/a\nrebased feat/b and pushed\nrebased feat/c and pushed\n`,
      );
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("hands-off", async () => {
    const fixture = await stackCase("skills-fix-round-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      const { temporary, repo, refusal } = await fixRoundCase(fixture, "hands-off");
      await writeFile(join(temporary, "skills.conf"), "DELIVERY=hands-off\n");
      await appendFile(join(repo, "round"), "change\n");

      await refusal("fix-round: delivery mode is not prs");
    } finally {
      await fixture.dispose();
    }
  });

  for (const [name, branch, reason] of [
    ["unowned-current", "feat/a", "feat/a is not an owned branch"],
    ["unowned-layer", "feat/b", "feat/b above feat/a is not an owned branch"],
  ] as const)
    test.concurrent(name, async () => {
      const fixture = await stackCase("skills-fix-round-", {
        assertNoGhCalls: true,
        views: "deleted",
      });

      try {
        const { repo, index, refusal } = await fixRoundCase(fixture, name);
        await writeFile(
          index,
          (await readFile(index, "utf8"))
            .split("\n")
            .filter((line) => !line.includes(branch))
            .join("\n"),
        );

        await appendFile(join(repo, "round"), "change\n");

        await refusal(`fix-round: ${reason}`);
      } finally {
        await fixture.dispose();
      }
    });

  test.concurrent("two-children", async () => {
    const fixture = await stackCase("skills-fix-round-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      const { repo, branch, refusal } = await fixRoundCase(fixture, "two-children");
      await branch("feat/other", "feat/a", "feat/a");

      await appendFile(join(repo, "round"), "change\n");

      await refusal("fix-round: two layers above feat/a: feat/b feat/other");
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("a layer that is the default branch", async () => {
    const fixture = await stackCase("skills-fix-round-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      const { repo, origin, git, run, branches } = await fixRoundCase(fixture, "default-layer");
      await git([`--git-dir=${origin}`, "symbolic-ref", "HEAD", "refs/heads/feat/b"]);
      await appendFile(join(repo, "round"), "change\n");
      const before = await branches();

      const result = await run(fixRound, ["-P", "Proj", "-m", "fix: guard empty input", "round"]);

      expect([result.code, result.stdout, result.stderr]).toEqual([
        1,
        "",
        "fix-round: cannot rebase the default branch feat/b\n",
      ]);

      expect(await branches()).toEqual(before);
      expect(await git(["diff", "--cached", "--name-only"])).toBe("");
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("nothing", async () => {
    const fixture = await stackCase("skills-fix-round-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      const { refusal } = await fixRoundCase(fixture, "nothing");
      await refusal("fix-round: nothing to commit for this round");
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("staged", async () => {
    const fixture = await stackCase("skills-fix-round-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      const { repo, git, refusal } = await fixRoundCase(fixture, "staged");
      await appendFile(join(repo, "round"), "change\n");
      await writeFixture(repo, "outside", "outside\n");
      await git(["add", "--", "outside"]);

      await refusal("fix-round: already staged outside the file list: outside");
    } finally {
      await fixture.dispose();
    }
  });

  for (const [name, branch, reason] of [
    ["remote-layer", "feat/b", "origin/feat/b differs from feat/b, sync it first"],
    ["remote-current", "feat/a", "origin/feat/a has commits feat/a lacks"],
  ] as const)
    test.concurrent(name, async () => {
      const fixture = await stackCase("skills-fix-round-", {
        assertNoGhCalls: true,
        views: "deleted",
      });

      try {
        const { repo, git, refusal } = await fixRoundCase(fixture, name);
        await git(["checkout", "--quiet", branch]);
        await git(["commit", "--quiet", "--allow-empty", "-m", "feat: remote"]);
        await git(["push", "--quiet", "origin", branch]);

        await git(["reset", "--quiet", "--hard", "HEAD^"]);
        await git(["checkout", "--quiet", "feat/a"]);
        await appendFile(join(repo, "round"), "change\n");

        await refusal(`fix-round: ${reason}`);
      } finally {
        await fixture.dispose();
      }
    });

  for (const name of ["conflict", "upper-conflict"])
    test.concurrent(name, async () => {
      const fixture = await stackCase("skills-fix-round-", {
        assertNoGhCalls: true,
        views: "deleted",
      });

      try {
        const { repo, git, commit, refusal, holderAt, holderState, upperUnchanged } =
          await fixRoundCase(fixture, name);

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
      } finally {
        await fixture.dispose();
      }
    });

  test.concurrent("deletion", async () => {
    const fixture = await stackCase("skills-fix-round-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      const { origin, git, command, run, tip } = await fixRoundCase(fixture, "deletion");
      await git(["rm", "--quiet", "--", "a"]);

      const result = await run(fixRound, ["-P", "Proj", "-m", "fix: drop stale file", "a"]);
      expect(result.code, result.stderr).toBe(0);
      expect(
        (await command(["git", `--git-dir=${origin}`, "cat-file", "-e", "feat/a:a"])).code,
      ).not.toBe(0);

      await tip("feat/c", await git(["rev-parse", "feat/c"]));
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("unreadable-remote", async () => {
    const fixture = await stackCase("skills-fix-round-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      const { repo, refusal } = await fixRoundCase(fixture, "unreadable-remote");
      await gitShim(fixture, `  "ls-remote --exit-code "*) exit 128 ;;`);
      await appendFile(join(repo, "round"), "change\n");

      await refusal("fix-round: cannot read origin/feat/a");
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("unpublished", async () => {
    const fixture = await stackCase("skills-fix-round-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      const { repo, index, git, branch, refusal } = await fixRoundCase(fixture, "unpublished");
      await git(["branch", "-D", "--quiet", "feat/c"]);
      await branch("feat/d", "feat/a");
      await git(["checkout", "--quiet", "feat/d"]);

      await git(["config", "branch.feat/b.skills-base", "feat/d"]);
      await editView(fixture.env, index, (text) => `${text}4\t-\t-\t-\t-\t-\t-\tfeat/d\t-\t-\n`);
      await appendFile(join(repo, "round"), "change\n");

      await refusal("fix-round: origin has no feat/d, publish it first");
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("a layer named the tail of another origin branch", async () => {
    const fixture = await stackCase("skills-fix-round-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      const { repo, origin, git, command, round } = await fixRoundCase(fixture, "tail-branch");
      await git(["push", "--quiet", "origin", "feat/c:refs/heads/old/feat/c"]);
      await git(["push", "--quiet", "origin", "feat/c:refs/heads/old/refs/heads/feat/c"]);
      await git(["push", "--quiet", "origin", "--delete", "feat/c"]);
      await appendFile(join(repo, "round"), "change\n");

      const result = await round();
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("rebased feat/c (not on origin, not pushed)\n");

      const originC = await command(
        ["git", `--git-dir=${origin}`, "rev-parse", "--verify", "--quiet", "refs/heads/feat/c"],
        repo,
      );

      expect(originC.code).not.toBe(0);
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("a round commits under log.showSignature with signed commits", async () => {
    const fixture = await stackCase("skills-fix-round-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      const { temporary, repo, git, succeed, round } = await fixRoundCase(fixture, "signed");
      const key = join(temporary, "signing-key");
      await succeed(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", key]);

      const publicKey = (await readFile(`${key}.pub`, "utf8")).trimEnd();
      const signers = join(temporary, "allowed-signers");
      await writeFile(signers, `test@example.com ${publicKey}\n`);

      await git(["config", "gpg.format", "ssh"]);
      await git(["config", "user.signingkey", key]);
      await git(["config", "gpg.ssh.allowedSignersFile", signers]);
      await git(["config", "commit.gpgsign", "true"]);

      await git(["config", "log.showSignature", "true"]);
      await appendFile(join(repo, "round"), "change\n");

      const result = await round();
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toStartWith(
        `committed ${await git(["rev-parse", "--short", "HEAD"])} on feat/a\n`,
      );

      expect(await git(["log", "-1", "--no-show-signature", "--format=%s"])).toBe(
        "fix: guard empty input",
      );
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("held-layer", async () => {
    const fixture = await stackCase("skills-fix-round-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      const { repo, git, round, holderAt, tip } = await fixRoundCase(fixture, "held-layer");
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
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("doing-layer", async () => {
    const fixture = await stackCase("skills-fix-round-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      const { repo, origin, git, refusal, doing } = await fixRoundCase(fixture, "doing-layer");
      const oldA = await git([`--git-dir=${origin}`, "rev-parse", "feat/a"]);
      await doing();
      await appendFile(join(repo, "round"), "change\n");

      await refusal("fix-round: row 3 is DOING on feat/c");
      expect(await git([`--git-dir=${origin}`, "rev-parse", "feat/a"])).toBe(oldA);
    } finally {
      await fixture.dispose();
    }
  });

  for (const busy of ["tracked", "rebase", "deleted", "doing"])
    test.concurrent(`busy-${busy}`, async () => {
      const fixture = await stackCase("skills-fix-round-", {
        assertNoGhCalls: true,
        views: "deleted",
      });

      try {
        const { env, repo, command, refusal, branches, holderAt, holderState, doing } =
          await fixRoundCase(fixture, `busy-${busy}`);

        const holder = await holderAt(`held-${busy}`);

        let reason = holder;
        if (busy === "tracked") await appendFile(join(holder, "c"), "dirty\n");
        else if (busy === "rebase")
          expect(
            (await command(["git", "rebase", "--exec", "false", "HEAD^"], holder)).code,
          ).not.toBe(0);
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
      } finally {
        await fixture.dispose();
      }
    });

  test.concurrent("lease_race", async () => {
    const fixture = await stackCase("skills-fix-round-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      const { repo, origin, git, refusal, holderAt, holderState, tip, executable } =
        await fixRoundCase(fixture, "lease_race");

      const oldB = await git(["rev-parse", "feat/b"]);
      const oldC = await git(["rev-parse", "feat/c"]);

      const holder = await holderAt("held-race");
      const before = await holderState(holder);

      const { realGit } = fixture;
      const racer = await fixture.clone(origin, "racer");

      await executable(
        "lease_race/Proj/.git/hooks/pre-push",
        `#!/bin/sh
case $(cat) in
  *refs/heads/feat/c*)
    cd "${racer}"
    "${realGit}" checkout --quiet feat/c
    printf 'race\\n' >> c
    "${realGit}" commit --quiet -am 'fix: race'
    "${realGit}" push --quiet origin feat/c
    ;;
esac
`,
      );

      await appendFile(join(repo, "round"), "change\n");

      await refusal(
        "lease push rejected, the round is pushed on feat/a, every layer above it is untouched",
      );

      await tip("feat/b", oldB);
      await tip("feat/c", oldC, await git(["rev-parse", "feat/c"], racer));
      await tip("feat/a", await git(["rev-parse", "feat/a"]));
      expect(await holderState(holder)).toEqual(before);
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("holder-busy-after-push", async () => {
    const fixture = await stackCase("skills-fix-round-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      const { temporary, repo, git, round, holderAt, tip, executable } = await fixRoundCase(
        fixture,
        "holder-busy-after-push",
      );

      const oldB = await git(["rev-parse", "feat/b"]);
      const oldC = await git(["rev-parse", "feat/c"]);
      const holder = await holderAt("held-after-push");
      await executable(
        "holder-busy-after-push/Proj/.git/hooks/pre-push",
        `#!/bin/sh
case $(cat) in
  *refs/heads/feat/c*)
    if [ ! -f "${temporary}/busy-hook-ran" ]; then
      printf 'busy\\n' >> "${holder}/c"
      touch "${temporary}/busy-hook-ran"
    fi
    ;;
esac
`,
      );

      await appendFile(join(repo, "round"), "change\n");

      const result = await round();
      expect(result.code, result.stderr).toBe(1);
      expect(result.stderr).toContain(
        `fix-round: cannot move feat/c: feat/c is held by ${holder} with tracked changes`,
      );

      const newB = await git(["rev-parse", "feat/b"]);
      expect(newB).not.toBe(oldB);
      expect(await git(["rev-parse", "feat/b^"])).toBe(await git(["rev-parse", "feat/a"]));
      await tip("feat/b", newB);
      await tip("feat/c", oldC);

      expect(await git(["rev-parse", "HEAD"], holder)).toBe(oldC);
      expect(await readFile(join(holder, "c"), "utf8")).toBe("c1\nbusy\n");
      expect(result.stdout).toBe(
        `committed ${await git(["rev-parse", "--short", "HEAD"])} on feat/a\npushed feat/a\nrebased feat/b and pushed\n`,
      );
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("no-ref-action", async () => {
    const fixture = await stackCase("skills-fix-round-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      const { repo, refusal, branches } = await fixRoundCase(fixture, "no-ref-action");
      await oldReplayGit(fixture);
      await appendFile(join(repo, "round"), "change\n");
      const before = await branches();

      await refusal("git replay lacks --ref-action");
      expect(await branches()).toEqual(before);
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("a single layer round needs no ref-action", async () => {
    const fixture = await stackCase("skills-fix-round-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      const { repo, git, origin, round } = await fixRoundCase(fixture, "single-layer");
      await oldReplayGit(fixture);
      await git(["checkout", "--quiet", "feat/c"]);
      await appendFile(join(repo, "round"), "change\n");

      const result = await round();
      expect(result.code, result.stderr).toBe(0);

      const head = await git(["rev-parse", "HEAD"]);
      expect(result.stdout).toBe(
        `committed ${await git(["rev-parse", "--short", "HEAD"])} on feat/c\npushed feat/c\n`,
      );

      expect(await git([`--git-dir=${origin}`, "rev-parse", "feat/c"])).toBe(head);
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("wrong checkout", async () => {
    const fixture = await stackCase("skills-fix-round-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      const { refusal } = await fixRoundCase(fixture, "wrong-checkout");
      const other = await stackRepo(fixture, {
        name: "other",
        commits: [{ branch: "main", message: "chore: initial" }],
        checkout: "main",
      });

      await other.branch("feat/other", "main");
      await other.git(["checkout", "--quiet", "feat/other"]);

      const { git, repo, origin } = other;
      const refs = ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"];
      const branches = async () => ({
        local: await git(refs),
        remote: await git([`--git-dir=${origin}`, ...refs]),
        tree: await git(["status", "--porcelain"]),
        branch: await git(["branch", "--show-current"]),
      });

      const before = await branches();
      const remote = await git(["ls-remote", "origin"]);

      await refusal(
        "fix-round: this checkout is other, not a checkout of fixture",
        ["-P", "fixture", "-m", "fix: guard empty input", "round"],
        repo,
      );

      expect(await branches()).toEqual(before);
      expect(await git(["ls-remote", "origin"])).toBe(remote);
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("matching worktree without index", async () => {
    const fixture = await stackCase("skills-fix-round-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      const { index, refusal, holderAt } = await fixRoundCase(fixture, "matching-worktree");
      const holder = await holderAt("t3code-0000");
      await rm(index);

      const result = await refusal(
        "fix-round: no index.tsv for Proj",
        ["-P", "Proj", "-m", "fix: guard empty input", "round"],
        holder,
      );

      expect(result.stderr).not.toContain("not a checkout of");
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("subdirectory staged deletion", async () => {
    const fixture = await stackCase("skills-fix-round-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      const { repo, origin, git, command, run, commit, tip } = await fixRoundCase(
        fixture,
        "subdirectory-deletion",
      );

      await writeFixture(repo, "nested/stale", "stale\n");
      await commit("feat/a", "feat: stale file", ["nested/stale"]);
      await git(["rm", "--quiet", "--", "nested/stale"]);
      await mkdir(join(repo, "nested"), { recursive: true });

      const result = await run(
        fixRound,
        ["-PProj", "-mfix: drop stale file", "--", "stale"],
        join(repo, "nested"),
      );

      expect(result.code, result.stderr).toBe(0);
      expect(
        (await command(["git", `--git-dir=${origin}`, "cat-file", "-e", "feat/a:nested/stale"]))
          .code,
      ).not.toBe(0);

      await tip("feat/c", await git(["rev-parse", "feat/c"]));
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("recorded base cycle", async () => {
    const fixture = await stackCase("skills-fix-round-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      const { repo, git, refusal, branches } = await fixRoundCase(fixture, "base-cycle");
      await git(["config", "branch.feat/a.skills-base", "feat/c"]);
      await appendFile(join(repo, "round"), "change\n");
      const before = await branches();

      await refusal("fix-round: cycle in recorded bases at feat/a");
      expect(await branches()).toEqual(before);
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("failed branch push", async () => {
    const fixture = await stackCase("skills-fix-round-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      const { repo, origin, git, refusal, tip, executable } = await fixRoundCase(
        fixture,
        "failed-branch-push",
      );

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
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("rerun after a failed push", async () => {
    const fixture = await stackCase("skills-fix-round-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      const { repo, git, round, refusal, tip, executable } = await fixRoundCase(
        fixture,
        "rerun-failed-push",
      );

      await executable("rerun-failed-push/Proj/.git/hooks/pre-push", "#!/bin/sh\nexit 1\n");
      const oldA = await git(["rev-parse", "feat/a"]);
      await appendFile(join(repo, "round"), "change\n");
      await refusal("fix-round: git push failed");

      await rm(join(repo, ".git/hooks/pre-push"));
      const result = await round();
      expect(result.code, result.stderr).toBe(0);

      const short = await git(["rev-parse", "--short", "feat/a"]);
      expect(result.stdout).toBe(
        `committed ${short} on feat/a\npushed feat/a\nrebased feat/b and pushed\nrebased feat/c and pushed\n`,
      );

      expect(await git(["rev-list", "--count", `${oldA}..feat/a`])).toBe("1");
      expect(await git(["rev-parse", "feat/a^"])).toBe(oldA);

      for (const branch of ["feat/a", "feat/b", "feat/c"])
        await tip(branch, await git(["rev-parse", branch]));

      expect(await git(["rev-parse", "feat/b^"])).toBe(await git(["rev-parse", "feat/a"]));
      expect(await git(["rev-parse", "feat/c^"])).toBe(await git(["rev-parse", "feat/b"]));
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("unpushed commit before the round", async () => {
    const fixture = await stackCase("skills-fix-round-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      const { repo, origin, git, round, refusal, executable } = await fixRoundCase(
        fixture,
        "unpushed-before-round",
      );

      await git(["branch", "-D", "--quiet", "feat/c"]);
      await git(["push", "--quiet", "origin", "--delete", "feat/b", "feat/c"]);

      await appendFile(join(repo, "a"), "a2\n");
      await git(["commit", "--quiet", "-am", "feat: a2"]);
      await git(["rebase", "--quiet", "feat/a", "feat/b"]);
      await git(["checkout", "--quiet", "feat/a"]);

      await executable("unpushed-before-round/Proj/.git/hooks/pre-push", "#!/bin/sh\nexit 1\n");
      await appendFile(join(repo, "round"), "change\n");
      await refusal("fix-round: git push failed");

      await rm(join(repo, ".git/hooks/pre-push"));
      const result = await round();
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("rebased feat/b (not on origin, not pushed)\n");

      expect(await git([`--git-dir=${origin}`, "rev-parse", "feat/a"])).toBe(
        await git(["rev-parse", "feat/a"]),
      );

      expect(await git(["log", "-1", "--format=%s", "feat/a"])).toBe("fix: guard empty input");
      expect(await git(["rev-list", "--count", "feat/a..feat/b"])).toBe("1");
      expect(await git(["rev-parse", "feat/b~1"])).toBe(await git(["rev-parse", "feat/a"]));
    } finally {
      await fixture.dispose();
    }
  });

  for (const subject of ["wip", ""])
    test.concurrent(`rerun refuses an unpushed subject "${subject}"`, async () => {
      const fixture = await stackCase("skills-fix-round-", {
        assertNoGhCalls: true,
        views: "deleted",
      });

      try {
        const { repo, origin, git, refusal } = await fixRoundCase(
          fixture,
          `bad-subject-${subject.length}`,
        );

        const remoteA = await git([`--git-dir=${origin}`, "rev-parse", "feat/a"]);
        await appendFile(join(repo, "a"), "a2\n");
        await git(["commit", "--quiet", "--allow-empty-message", "-am", subject]);
        await git(["commit", "--quiet", "--allow-empty", "-m", "fix: guard empty input"]);

        await refusal(
          `fix-round: unpushed commit "${subject}": no Conventional prefix, reword it first`,
        );

        expect(await git([`--git-dir=${origin}`, "rev-parse", "feat/a"])).toBe(remoteA);
      } finally {
        await fixture.dispose();
      }
    });

  test.concurrent("rerun after a failed push of a deletion", async () => {
    const fixture = await stackCase("skills-fix-round-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      const { repo, origin, git, command, run, refusal, tip, executable } = await fixRoundCase(
        fixture,
        "rerun-deletion",
      );

      const args = ["-P", "Proj", "-m", "fix: drop stale file", "a"];
      await executable("rerun-deletion/Proj/.git/hooks/pre-push", "#!/bin/sh\nexit 1\n");
      await git(["rm", "--quiet", "--", "a"]);
      await refusal("fix-round: git push failed", args);

      await rm(join(repo, ".git/hooks/pre-push"));
      const result = await run(fixRound, args);
      expect(result.code, result.stderr).toBe(0);

      expect(
        (await command(["git", `--git-dir=${origin}`, "cat-file", "-e", "feat/a:a"])).code,
      ).not.toBe(0);

      await tip("feat/c", await git(["rev-parse", "feat/c"]));
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("a missing path the unpushed commits never touched still refuses", async () => {
    const fixture = await stackCase("skills-fix-round-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      const { repo, git, refusal } = await fixRoundCase(fixture, "missing-untouched");
      await appendFile(join(repo, "a"), "a2\n");
      await git(["commit", "--quiet", "-am", "feat: a2"]);

      await refusal("fix-round: no such file: gone", [
        "-P",
        "Proj",
        "-m",
        "fix: guard empty input",
        "gone",
      ]);
    } finally {
      await fixture.dispose();
    }
  });

  for (const collision of ["untracked", "ignored", "ignored-dir"])
    test.concurrent(`holder-${collision}`, async () => {
      const fixture = await stackCase("skills-fix-round-", {
        assertNoGhCalls: true,
        views: "deleted",
      });

      try {
        const { repo, git, round, holderAt, holderState, upperUnchanged } = await fixRoundCase(
          fixture,
          `holder-${collision}`,
        );

        const oldB = await git(["rev-parse", "feat/b"]);
        const oldC = await git(["rev-parse", "feat/c"]);

        const holder = await holderAt(`collision-${collision}`);
        await writeFixture(
          holder,
          collision === "ignored-dir" ? "incoming/private" : "incoming",
          "stray\n",
        );

        if (collision !== "untracked")
          await appendFile(join(repo, ".git/info/exclude"), "incoming\n");

        const before = await holderState(holder);
        await writeFixture(repo, "incoming", "incoming\n");
        await appendFile(join(repo, "round"), "change\n");
        if (collision !== "untracked") await git(["add", "-f", "--", "incoming"]);

        const result = await round("incoming", "round");
        const reason =
          collision === "untracked"
            ? `feat/c is held by ${holder} and its files block the move`
            : `feat/c is held by ${holder} and an ignored file sits where the move adds one`;

        expect(result.code, result.stderr).toBe(1);
        expect(result.stderr).toContain(reason);
        expect(result.stdout).toBe("");
        await upperUnchanged(oldB, oldC);
        expect(await holderState(holder)).toEqual(before);
      } finally {
        await fixture.dispose();
      }
    });
});

describe("fix-round without -P", () => {
  async function rowless(fixture: StackCase, name: string, marked: readonly string[]) {
    const state = await fixRoundCase(fixture, name);
    await editView(fixture.env, state.index, (text) =>
      text
        .split("\n")
        .filter((line) => !/\tfeat\/(a|c)\t/.test(line))
        .join("\n"),
    );

    for (const branch of marked)
      await state.git(["config", `branch.${branch}.skills-owned`, "true"]);

    await appendFile(join(state.repo, "round"), "round change\n");

    const round = () => state.run(fixRound, ["-m", "fix: guard empty input", "round"]);
    return { ...state, round };
  }

  test.concurrent("a marked branch commits, pushes and restacks marked and listed layers", async () => {
    const fixture = await stackCase("skills-fix-round-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      const { git, round, tip } = await rowless(fixture, "marked", ["feat/a", "feat/c"]);
      const oldA = await git(["rev-parse", "feat/a"]);

      const result = await round();
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe(
        `committed ${await git(["rev-parse", "--short", "HEAD"])} on feat/a\npushed feat/a\nrebased feat/b and pushed\nrebased feat/c and pushed\n`,
      );

      expect(await git(["rev-parse", "feat/a^"])).toBe(oldA);

      for (const branch of ["feat/a", "feat/b", "feat/c"])
        await tip(branch, await git(["rev-parse", branch]));

      await git(["merge-base", "--is-ancestor", "feat/a", "feat/b"]);
      await git(["merge-base", "--is-ancestor", "feat/b", "feat/c"]);
    } finally {
      await fixture.dispose();
    }
  });

  for (const [name, marked, reason] of [
    ["unmarked-current", ["feat/c"], "fix-round: feat/a is not an owned branch"],
    ["unmarked-layer", ["feat/a"], "fix-round: feat/c above feat/a is not an owned branch"],
  ] as const)
    test.concurrent(name, async () => {
      const fixture = await stackCase("skills-fix-round-", {
        assertNoGhCalls: true,
        views: "deleted",
      });

      try {
        const { round, branches } = await rowless(fixture, name, marked);
        const before = await branches();

        const result = await round();
        expect([result.code, result.stdout]).toEqual([1, ""]);
        expect(result.stderr).toContain(reason);
        expect(await branches()).toEqual(before);
      } finally {
        await fixture.dispose();
      }
    });

  test.concurrent("a row in another project owns nothing", async () => {
    const fixture = await stackCase("skills-fix-round-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      const { env, round, branches } = await rowless(fixture, "elsewhere", ["feat/c"]);
      const other = join(env.PLANS_DIR ?? "", "Other");
      await mkdir(other, { recursive: true });
      await editView(
        env,
        join(other, "index.tsv"),
        () =>
          "id\tslug\tstatus\tpri\teffort\tblocked_by\tctx\tbranch\tupdated\tnote\n7\t-\tREVIEW\t-\t-\t-\t-\tfeat/a\t-\t-\n",
      );

      const before = await branches();

      const result = await round();
      expect([result.code, result.stdout]).toEqual([1, ""]);
      expect(result.stderr).toContain("fix-round: feat/a is not an owned branch");
      expect(await branches()).toEqual(before);
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("-P ignores the mark", async () => {
    const fixture = await stackCase("skills-fix-round-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      const { run, branches } = await rowless(fixture, "project-mark", ["feat/a", "feat/c"]);
      const before = await branches();

      const result = await run(fixRound, ["-P", "Proj", "-m", "fix: guard empty input", "round"]);
      expect([result.code, result.stdout]).toEqual([1, ""]);
      expect(result.stderr).toContain("fix-round: feat/a is not an owned branch");
      expect(await branches()).toEqual(before);
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("an unreadable project directory refuses", async () => {
    const fixture = await stackCase("skills-fix-round-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      const { env, round, branches } = await rowless(fixture, "unreadable", ["feat/a", "feat/c"]);
      const locked = join(env.PLANS_DIR ?? "", "Locked");
      await mkdir(locked);
      await writeFile(join(locked, "index.tsv"), "id\n");
      await chmod(locked, 0o000);

      const before = await branches();
      try {
        const result = await round();
        expect([result.code, result.stdout]).toEqual([1, ""]);
        expect(result.stderr).toContain(`fix-round: cannot read ${join(locked, "index.tsv")}`);
        expect(await branches()).toEqual(before);
      } finally {
        await chmod(locked, 0o755);
      }
    } finally {
      await fixture.dispose();
    }
  });

  test.concurrent("a DOING row on a layer still refuses", async () => {
    const fixture = await stackCase("skills-fix-round-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      const { index, round, branches } = await rowless(fixture, "doing", ["feat/a"]);
      await editView(
        fixture.env,
        index,
        (text) => `${text}3\t-\tDOING\t-\t-\t-\t-\tfeat/c\t-\t-\n`,
      );

      const before = await branches();

      const result = await round();
      expect([result.code, result.stdout]).toEqual([1, ""]);
      expect(result.stderr).toContain("fix-round: row 3 is DOING on feat/c");
      expect(await branches()).toEqual(before);
    } finally {
      await fixture.dispose();
    }
  });
});

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fixtureGit } from "../test/fixtures.ts";
import { classify, guard } from "./pre-tool-use.ts";

const guardOutput = async (...args: Parameters<typeof guard>) => (await guard(...args)).output;

const repoRoot = resolve(import.meta.dir, "../../../..");
const bin = join(repoRoot, "skills/playbook/bin/skills");
const declaration =
  "NAME=TestBot\nLOGINS=testbot testbot[bot]\nHANDLES=@testbot\nTRIGGER=@testbot review\nCHECK=TestBot\n";

type Output = {
  hookSpecificOutput: {
    hookEventName: string;
    permissionDecision: string;
    permissionDecisionReason: string;
  };
};

describe("CommitGuard", () => {
  let temporary: string;
  let root: string;
  let conf: string;
  let env: NodeJS.ProcessEnv;
  let fixtureId: number;

  beforeEach(() => {
    temporary = mkdtempSync(join(tmpdir(), "commit-guard-"));
    root = join(temporary, "skills");
    conf = join(temporary, "skills.conf");
    fixtureId = 0;

    mkdirSync(join(temporary, "home"));
    env = { ...process.env, HOME: join(temporary, "home"), SKILLS_CONF: conf, AGENT_HOOKS: "1" };
    delete env.AGENTS_DIR;
    delete env.AGENT_HOOKS_SKIP;

    reviewer("greptile", readFileSync(join(repoRoot, "skills/greptile/reviewer.conf"), "utf8"));
  });

  afterEach(() => {
    rmSync(temporary, { recursive: true, force: true });
  });

  function reviewer(name: string, contents: string): void {
    const directory = join(root, name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "SKILL.md"),
      "---\nname: " +
        name +
        "\ndescription: Reviewer extension.\noptional: true\nrequires: prs\n---\n",
    );

    writeFileSync(join(directory, "reviewer.conf"), contents);
  }

  async function output(
    input: string,
    contents = "DELIVERY=prs\n",
    extra: NodeJS.ProcessEnv = {},
  ): Promise<Output | null> {
    writeFileSync(conf, contents);

    const text = await guardOutput(input, root, { ...env, ...extra });
    if (!text) return null;

    const parsed: Output = JSON.parse(text);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    const escaped = JSON.stringify(parsed.hookSpecificOutput.permissionDecisionReason).replace(
      /[\x7f-\uffff]/g,
      (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"),
    );

    expect(text).toBe(
      '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": ' +
        escaped +
        "}}\n",
    );

    return parsed;
  }

  function guard(
    command: string | string[],
    contents = "DELIVERY=prs\n",
    extra: NodeJS.ProcessEnv = {},
    cwd?: string,
  ): Promise<Output | null> {
    return output(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
        ...(cwd === undefined ? {} : { cwd }),
      }),
      contents,
      extra,
    );
  }

  function reason(value: Output | null): string {
    expect(value).not.toBeNull();
    return value!.hookSpecificOutput.permissionDecisionReason;
  }

  async function pushRepo(withHead = true, parent = temporary): Promise<string> {
    fixtureId++;
    const repo = join(parent, "repo-" + fixtureId);
    const origin = join(temporary, "origin-" + fixtureId + ".git");
    mkdirSync(repo);
    await fixtureGit(repo, ["init", "-q", "-b", "main"]);
    await fixtureGit(repo, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ]);

    await fixtureGit(repo, ["checkout", "-q", "-b", "feat/x"]);
    await fixtureGit(temporary, ["init", "-q", "--bare", origin]);
    await fixtureGit(repo, ["remote", "add", "origin", origin]);
    await fixtureGit(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

    if (withHead)
      await fixtureGit(repo, [
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
      ]);

    return repo;
  }

  test("test_allowed_commits_in_prs_mode", async () => {
    for (const command of [
      'git commit -m "feat: add guard"',
      "git -C /tmp/x commit -m 'fix(hooks): x'",
      'git commit --message="feat: y"',
      'gh stack add -m "chore: z"',
      'gh stack add feat/b -m "docs: w"',
      'git commit -m "feat: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"',
    ])
      expect(await guard(command)).toBeNull();
  });

  test("test_denied_commits", async () => {
    for (const command of [
      'git commit -m "feat: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"',
      'git commit -m "add guard"',
      'git commit -m "$(printf feat: x)"',
      'git commit -m "feat: x\ny"',
      "git commit -F - <<EOF\nfeat: x\nEOF",
      'git commit -m "feat: x\nCo-Authored-By: a <b>"',
      'git commit -m "feat: x" -m "fix: y"',
      "git commit -F file",
      "git commit --file=x",
      'git commit --trailer "Co-Authored-By: a <b>"',
      "git commit --template t",
      "git commit",
      'git commit --amend -m "feat: x"',
      "git commit --amend --no-edit",
      'git commit -am "feat: x"',
      'git commit -m "feat: x" && git push',
      "bash -c \"git commit -m 'feat: x'\"",
    ])
      expect(reason(await guard(command))).toContain("git commit -m");
  });

  test("test_hands_off_denies_every_allowed_commit", async () => {
    for (const command of [
      'git commit -m "feat: add guard"',
      "git -C /tmp/x commit -m 'fix(hooks): x'",
      'git commit --message="feat: y"',
      'gh stack add -m "chore: z"',
      'gh stack add feat/b -m "docs: w"',
    ]) {
      const denial = reason(await guard(command, "DELIVERY=hands-off\n"));
      expect(denial).toContain("hands-off mode");
      expect(denial).toContain("git commit -m");
    }
  });

  test("test_hands_off_denies_committing_verbs", async () => {
    for (const command of [
      "git cherry-pick abc1234",
      "git revert HEAD",
      "git am fix.mbox",
      "git am -n fix.mbox",
      "git cherry-pick --continue",
      "git -C sub revert HEAD",
      "git merge feature",
      'git merge -m "any text" feature',
      "git merge --continue",
      "git pull",
      "git pull origin main",
      "git pull --rebase",
    ]) {
      const denial = reason(await guard(command, "DELIVERY=hands-off\n"));
      expect(denial).toContain("hands-off mode");
      expect(denial).toContain("git commit -m");
    }
  });

  test("test_prs_denies_committing_verbs_with_the_shaped_route", async () => {
    for (const command of ["git cherry-pick abc1234", "git revert HEAD"]) {
      const denial = reason(await guard(command));
      expect(denial).toContain("-n");
      expect(denial).toContain("git commit -m");
    }

    expect(reason(await guard("git cherry-pick abc1234"))).toContain(
      "skills takeover <pr> to carry another author's commits",
    );

    expect(reason(await guard("git revert HEAD"))).not.toContain("skills takeover");
    expect(reason(await guard("git am fix.mbox"))).toContain("git apply");

    const merge = reason(await guard("git merge feature"));
    expect(merge).toContain("--no-commit");
    expect(merge).toContain("git commit -m");
    expect(reason(await guard("git pull"))).toContain("--ff-only");
  });

  test("test_chained_committing_verbs_take_the_chained_commit_path", async () => {
    for (const contents of ["DELIVERY=prs\n", "DELIVERY=hands-off\n"])
      for (const command of [
        "git revert HEAD && git push",
        "echo $(git cherry-pick abc1234)",
        "bash -c 'git am fix.mbox'",
        "git revert --no-edit HEAD\necho -n",
        "git am -- --abort",
        "git am --abort fix.mbox",
        "git cherry-pick -n --commit abc1234",
        "git cherry-pick --no-commit --strategy-option=theirs abc1234",
        "git fetch && git merge feature",
        "echo $(git pull)",
        "bash -c 'git merge --ff-only feature'",
        "git merge --squash --no-verify feature",
        "git merge --no-commit feature $(printf %s --commit)",
        "git merge --no-commit feature `printf %s --commit`",
        'git merge --no-commit feature "$FLAGS"',
        "git cherry-pick -n abc1234 $(printf %s --commit)",
        "git merge --no-commit feature {--commit,--no-edit}",
        "git merge --ff-only feature --c*",
        `bash -c 'git merge"" --ff-only feature'`,
        `echo "git pull --ff-only" | bash`,
        "git merge -m $'it\\'s' feature",
        'git merge --no-commit -m ";" --commit feature',
        `git cherry-pick -n -m "|" --commit abc1234`,
        `git mer""ge -m $'it\\'s' feature`,
        ": ${unused:- #}; git merge feature",
        "git merge --no-commit > /dev/null --commit feature",
        "git merge --no-commit -m -- --commit feature",
        "git fetch && git merge --ff-only feature",
        "git cherry-pick -n abc1234 > /dev/null --commit",
        "git merge --no-commit -#commit feature",
        "git merge --no-commit feature ^main",
        "git cherry-pick -n abc1234 =x",
        "bash -c $'git merge feature'",
        "bash -c $'git pull'",
        "bash -c $'git merge --ff-only feature'",
      ])
        expect(reason(await guard(command, contents))).toContain("git commit -m");
  });

  test("test_non_committing_verb_forms_pass", async () => {
    for (const contents of ["DELIVERY=prs\n", "DELIVERY=hands-off\n"])
      for (const command of [
        "git cherry-pick -n abc1234",
        "git revert --no-commit HEAD",
        "git cherry-pick --abort",
        "git am --quit",
        "git am --show-current-patch",
        "git am --show-current-patch=diff",
        "git am --show-current-patch=raw",
        "git merge --ff-only feature",
        "git merge --no-commit feature",
        "git merge --squash feature",
        "git merge --abort",
        "git pull --ff-only",
        "git pull --ff-only origin main",
        "git merge-base --is-ancestor main HEAD",
        "bash -c 'git merge-base --is-ancestor main HEAD'",
        "bash -c 'git merge-base main feat/merge'",
        "bash -c 'git merge-base main merge'",
        "bash -c 'git fetch origin pull'",
        "bash -c 'git merge-file ours base theirs'",
        "bash -c 'git merge-tree main feature'",
        "bash -c 'git fetch origin pull/123/head:pr-123'",
        "git merge-base HEAD $'it\\'s'",
        "git rebase --continue",
      ])
        expect(await guard(command, contents)).toBeNull();
  });

  test("test_allowed_typed_pushes_in_prs_mode", async () => {
    const repo = await pushRepo();
    for (const command of [
      "git push origin feat/x",
      "git push -u origin feat/x",
      "git push -q origin feat/x",
      "git push -u -q origin feat/x",
      "git push -q -u origin feat/x",
      "git push origin refs/heads/feat/x:refs/heads/feat/x",
      "git push -u origin refs/heads/feat/x:refs/heads/feat/x",
      "git push -q origin refs/heads/feat/x:refs/heads/feat/x",
      "git push -u -q origin refs/heads/feat/x:refs/heads/feat/x",
      "git push -q -u origin refs/heads/feat/x:refs/heads/feat/x",
    ])
      expect(await guard(command, undefined, undefined, repo)).toBeNull();

    const outside = join(temporary, "outside");
    mkdirSync(outside);
    expect(
      await guard("git -C " + repo + " push -u origin feat/x", undefined, undefined, outside),
    ).toBeNull();

    expect(
      await guard(
        "git -C " + basename(repo) + " push -u origin feat/x",
        undefined,
        undefined,
        temporary,
      ),
    ).toBeNull();
  });

  test("test_typed_pushes_outside_the_allowed_shape_are_denied", async () => {
    const repo = await pushRepo();
    for (const command of [
      "git push -f origin feat/x",
      "git push -fu origin feat/x",
      "git push -uf origin feat/x",
      "git push --force origin feat/x",
      "git push --force-with-lease origin feat/x",
      "git push --force-with-lease=feat/x origin feat/x",
      "git push --force-with-lease=feat/x:abc123 origin feat/x",
      "git push --force-if-includes origin feat/x",
      "git push origin +feat/x",
      "git push origin refs/heads/*:refs/heads/*",
      "git push origin feat/x feat/y",
      "git push --mirror origin",
      "git push --all origin",
      "git push --prune origin feat/x",
      "git push --delete origin feat/x",
      "git push -d origin feat/x",
      "git push origin :feat/x",
      "git push",
      "git push origin",
      "git -c push.default=current push origin feat/x",
      "git -c alias.p=push p origin feat/x",
      "git send-pack origin feat/x",
      "gh stack push",
      "gh stack sync",
      "gh stack submit --auto --open",
      "gh stack link",
      "git push origin feat/x && true",
      "git push origin feat/x | cat",
      'echo "$(git push origin feat/x)"',
      "echo `git push origin feat/x`",
      'bash -c "git push origin feat/x"',
      "sh -c 'git push -f origin feat/x'",
    ]) {
      const denial = reason(await guard(command, undefined, undefined, repo));
      expect(denial).toContain("git push [-u] [-q] origin <branch>");
      expect(denial).toMatch(
        /skills publish|skills fix-round|skills lease-rebase|skills restack-layer/,
      );
    }
  });

  test("test_hands_off_denies_every_allowed_typed_push", async () => {
    const repo = await pushRepo();
    for (const command of [
      "git push origin feat/x",
      "git push -u origin feat/x",
      "git push -q origin feat/x",
      "git push -u -q origin feat/x",
      "git push -q -u origin feat/x",
      "git push origin refs/heads/feat/x:refs/heads/feat/x",
      "git push -u origin refs/heads/feat/x:refs/heads/feat/x",
      "git push -q origin refs/heads/feat/x:refs/heads/feat/x",
      "git push -u -q origin refs/heads/feat/x:refs/heads/feat/x",
      "git push -q -u origin refs/heads/feat/x:refs/heads/feat/x",
    ])
      expect(reason(await guard(command, "DELIVERY=hands-off\n", undefined, repo))).toContain(
        "hands-off mode",
      );

    const outside = join(temporary, "outside");
    mkdirSync(outside);
    expect(
      reason(
        await guard(
          "git -C " + repo + " push -u origin feat/x",
          "DELIVERY=hands-off\n",
          undefined,
          outside,
        ),
      ),
    ).toContain("hands-off mode");

    expect(
      reason(
        await guard(
          "git -C " + basename(repo) + " push -u origin feat/x",
          "DELIVERY=hands-off\n",
          undefined,
          temporary,
        ),
      ),
    ).toContain("hands-off mode");
  });

  test("test_default_branch_typed_pushes_are_denied", async () => {
    const repo = await pushRepo();
    const outside = join(temporary, "outside");
    mkdirSync(outside);
    const cases = [
      ["git push origin main", repo],
      ["git push origin refs/heads/main:refs/heads/main", repo],
      ["git -C " + repo + " push origin main", outside],
    ];

    for (const [command, cwd] of cases)
      expect(reason(await guard(command!, undefined, undefined, cwd))).toContain(
        "main is the default branch",
      );
  });

  test("test_typed_push_needs_origin_head_and_a_local_branch", async () => {
    const noHead = await pushRepo(false);
    expect(reason(await guard("git push origin feat/x", undefined, undefined, noHead))).toContain(
      "git remote set-head origin -a",
    );

    const repo = await pushRepo();
    expect(reason(await guard("git push origin feat/y", undefined, undefined, repo))).toContain(
      "not a local branch",
    );
  });

  test("a typed push ignores the inherited git env", async () => {
    const repo = await pushRepo();
    const other = join(await pushRepo(false), ".git");
    const inherited = { GIT_DIR: other, GIT_COMMON_DIR: other };
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_COMMON_DIR: process.env.GIT_COMMON_DIR };
    Object.assign(process.env, inherited);

    try {
      const unscrubbed = Bun.spawnSync(
        ["git", "-C", repo, "symbolic-ref", "refs/remotes/origin/HEAD"],
        { env: { ...env, ...inherited }, stdout: "ignore", stderr: "ignore" },
      );

      expect(unscrubbed.exitCode).not.toBe(0);
      expect(await guard("git push origin feat/x", undefined, inherited, repo)).toBeNull();
    } finally {
      for (const [name, value] of Object.entries(saved))
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
  });

  test("test_tilde_push_directory_expands_against_home", async () => {
    const repo = await pushRepo(true, env.HOME);
    const outside = join(temporary, "outside");
    mkdirSync(outside);

    const directory = "~/" + basename(repo);
    expect(
      await guard("git -C " + directory + " push -u origin feat/x", undefined, undefined, outside),
    ).toBeNull();

    expect(
      reason(
        await guard("git -C " + directory + " push origin main", undefined, undefined, outside),
      ),
    ).toContain("main is the default branch");
  });

  test("test_non_ascii_push_directory_is_judged", async () => {
    const parent = join(temporary, "café");
    mkdirSync(parent);

    const repo = await pushRepo(true, parent);
    const outside = join(temporary, "outside");
    mkdirSync(outside);

    expect(
      await guard("git -C " + repo + " push origin feat/x", undefined, undefined, outside),
    ).toBeNull();

    expect(
      reason(await guard("git -C " + repo + " push origin main", undefined, undefined, outside)),
    ).toContain("main is the default branch");
  });

  test("test_quoted_git_words_keep_the_tilde_expanding", async () => {
    const outside = join(temporary, "outside");
    mkdirSync(join(outside, "~"), { recursive: true });

    const literal = await pushRepo(true, join(outside, "~"));
    const home = join(env.HOME!, basename(literal));
    renameSync(await pushRepo(true, env.HOME), home);
    await fixtureGit(home, ["update-ref", "refs/remotes/origin/feat/x", "HEAD"]);
    await fixtureGit(home, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/feat/x",
    ]);

    const directory = "~/" + basename(literal);
    for (const command of [
      "'git' -C " + directory + " push origin feat/x",
      "git '-C' " + directory + " push origin feat/x",
    ])
      expect(reason(await guard(command, undefined, undefined, outside))).toContain(
        "feat/x is the default branch",
      );

    for (const command of [
      "git -C ~nobody/x push origin feat/x",
      "git -C ~+ push origin feat/x",
      "git -C ~- push origin feat/x",
      'git -C ~"/' + basename(literal) + '" push origin feat/x',
      "git -C ~'/" + basename(literal) + "' push origin feat/x",
      "git -C ~/'" + basename(literal) + "' push origin feat/x",
      "git -C ''" + directory + " push origin feat/x",
      'git -C ""' + directory + " push origin feat/x",
      "git -C " + directory + "{,} push origin feat/x",
      "git -C " + directory + "[1-9] push origin feat/x",
      "git -C " + directory + "* push origin feat/x",
      "git -C =git push origin feat/x",
      "git -C " + directory + " {1..1} push origin feat/x",
      "git -C " + directory + " [1] push origin feat/x",
    ])
      expect(classify(command).kind).toBe("DENY_PUSH");
  });

  test("test_empty_home_expands_the_tilde_to_nothing", async () => {
    const repo = await pushRepo();
    expect(await guard("git -C ~ push origin feat/x", undefined, { HOME: "" }, repo)).toBeNull();

    await fixtureGit(repo, ["update-ref", "refs/remotes/origin/feat/x", "HEAD"]);
    await fixtureGit(repo, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/feat/x",
    ]);

    expect(
      reason(await guard("git -C ~ push origin feat/x", undefined, { HOME: "" }, repo)),
    ).toContain("feat/x is the default branch");
  });

  test("test_quoted_tilde_push_directory_stays_literal", async () => {
    const outside = join(temporary, "outside");
    mkdirSync(join(outside, "~"), { recursive: true });

    const literal = await pushRepo(true, join(outside, "~"));
    await fixtureGit(literal, ["update-ref", "refs/remotes/origin/feat/x", "HEAD"]);
    await fixtureGit(literal, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/feat/x",
    ]);

    renameSync(await pushRepo(true, env.HOME), join(env.HOME!, basename(literal)));

    const directory = "~/" + basename(literal);
    for (const command of [
      "git -C '" + directory + "' push origin feat/x",
      'git -C "' + directory + '" push origin feat/x',
      ["git", "-C", directory, "push", "origin", "feat/x"],
    ])
      expect(reason(await guard(command, undefined, undefined, outside))).toContain(
        "feat/x is the default branch",
      );
  });

  test("test_push_reads_the_workdir_repository", async () => {
    const withHead = await pushRepo();
    const noHead = await pushRepo(false);
    const push = (command: string, workdir: string, cwd: string) =>
      output(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command, workdir },
          cwd,
        }),
      );

    expect(await push("git push origin feat/x", withHead, noHead)).toBeNull();
    expect(reason(await push("git push origin feat/x", noHead, withHead))).toContain(
      "git remote set-head origin -a",
    );

    expect(await push("git push origin feat/x", basename(withHead), temporary)).toBeNull();
    expect(
      await push("git -C " + basename(withHead) + " push origin feat/x", temporary, noHead),
    ).toBeNull();
  });

  test("test_remapped_push_destination_needs_the_explicit_refspec", async () => {
    const repo = await pushRepo();
    await fixtureGit(repo, ["config", "remote.origin.push", "refs/heads/feat/x:refs/heads/main"]);
    expect(reason(await guard("git push origin feat/x", undefined, undefined, repo))).toContain(
      "remote.origin.push",
    );

    expect(
      await guard(
        "git push origin refs/heads/feat/x:refs/heads/feat/x",
        undefined,
        undefined,
        repo,
      ),
    ).toBeNull();
  });

  test("test_upstream_push_default_needs_the_explicit_refspec", async () => {
    const repo = await pushRepo();
    await fixtureGit(repo, ["config", "branch.feat/x.remote", "origin"]);
    await fixtureGit(repo, ["config", "branch.feat/x.merge", "refs/heads/main"]);

    const explicit = "git push origin refs/heads/feat/x:refs/heads/feat/x";
    for (const value of ["upstream", "tracking"]) {
      await fixtureGit(repo, ["config", "push.default", value]);

      const denial = reason(await guard("git push origin feat/x", undefined, undefined, repo));
      expect(denial).toContain("push.default");
      expect(denial).toContain(explicit);
      expect(await guard(explicit, undefined, undefined, repo)).toBeNull();
    }

    await fixtureGit(repo, ["config", "push.default", "simple"]);
    expect(await guard("git push origin feat/x", undefined, undefined, repo)).toBeNull();

    writeFileSync(join(repo, ".git/config"), "[broken\n", { flag: "a" });
    expect(reason(await guard("git push origin feat/x", undefined, undefined, repo))).toContain(
      "git could not be read",
    );
  });

  test("test_brace_refspec_is_an_unsupported_push", async () => {
    const repo = await pushRepo();
    for (const name of [
      "topic",
      "{main,topic}",
      "{-f,topic}",
      "#x",
      "'{main,x}'",
      "topic's",
      "=fix",
    ])
      await fixtureGit(repo, ["branch", name]);

    for (const command of [
      "git push origin {main,topic}",
      "git push origin {-f,topic}",
      "git push origin refs/heads/{main,topic}:refs/heads/{main,topic}",
      "git push origin #x",
      `git push origin "'"{main,x}"'"`,
    ])
      expect(reason(await guard(command, undefined, undefined, repo))).toContain(
        "unsupported push",
      );

    for (const command of [
      "git push origin '{main,topic}'",
      ["git", "push", "origin", "{main,topic}"],
      ["git", "push", "origin", "topic's"],
      ["git", "push", "origin", "=fix"],
      'git push origin topic"\'"s',
    ])
      expect(await guard(command, undefined, undefined, repo)).toBeNull();
  });

  test("test_command_line_alias_spellings_count_as_a_push", async () => {
    for (const contents of ["DELIVERY=prs\n", "DELIVERY=hands-off\n"]) {
      for (const command of [
        "git -calias.p=push p origin feat/x",
        "git --config-env=alias.p=P p origin feat/x",
        "git --config-env alias.p=P p origin feat/x",
        "git --config-env=ALIAS.p=P p origin feat/x",
        "git --config-env=alias.p=P p origin main # '",
        "bash -c 'git --config-env=alias.p=P p origin main'",
        "git --config-env='alias.p=P' p origin main # '",
        `bash -c 'git --config-env="alias.p=P" p origin main'`,
        `bash -c 'git --config-env=al"ias".p=P p origin main'`,
        "git -c $'alias.p=push' p origin main",
        "git --config-env=$'alias.p=P' p origin main # '",
        `bash -c "git --config-env=\\$'alias.p=P' p origin main"`,
        "git -c $(printf alias.p=push) p origin main",
        'git -c "$(printf alias.p=push)" p origin main',
        "git --config-env=al$'ias.p'=P p origin main # '",
        "git -c {alias,x}.p=push p origin main",
        "git --shallow-file /dev/null -c alias.p=push p origin main",
        "bash -c $'git --config-env=alias.p=P p origin main'",
        "bash -c $'git push origin main'",
        "bash -c $'gh stack push'",
        "eval $'git push origin main'",
      ])
        expect(reason(await guard(command, contents))).toContain(
          "git push [-u] [-q] origin <branch>",
        );

      for (const command of [
        "bash -c $'git commit --amend --no-edit'",
        "bash -c $'git cherry-pick HEAD'",
      ])
        expect(reason(await guard(command, contents))).toContain("git commit -m");

      expect(reason(await guard("bash -c $'gh pr comment 12 --body bad'", contents))).toContain(
        "gh pr comment <number>",
      );

      for (const command of [
        "git -cuser.name=x status",
        "git -c user.name=$USER status",
        "git log -c",
        "git show -c $sha",
        "bash -c 'git show -c $sha'",
        "git -c 'http.https://example.com/.extraHeader=x' status",
        `bash -c 'git status --porcelain -- "pu""sh"'`,
      ])
        expect(await guard(command, contents)).toBeNull();
    }
  });

  test("test_env_config_aliases_count_as_a_push", async () => {
    for (const contents of ["DELIVERY=prs\n", "DELIVERY=hands-off\n"]) {
      for (const command of [
        "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p origin feat/x",
        "env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p origin feat/x",
        "export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push; git p origin feat/x",
        `GIT_CONFIG_PARAMETERS="'alias.p=push'" git p origin feat/x`,
        "GIT_CONFIG_KEY_0=Alias.P git status",
        "sh -c 'GIT_CONFIG_KEY_0=alias.p git p origin feat/x'",
        "GIT_CONFIG_KEY_0=alias.p\ngit p origin main",
        "GIT_CONFIG_KEY_0=alias.p; export GIT_CONFIG_KEY_0; git p origin main",
        "export GIT_CONFIG_KEY_0=alias.p; sh -c 'git p origin main'",
        "export GIT_CONFIG_KEY_0=alias.p; (unset GIT_CONFIG_KEY_0); git p origin main",
        "export GIT_CONFIG_KEY_0=alias.p; false && unset GIT_CONFIG_KEY_0; git p origin main",
        "export GIT_CONFIG_KEY_0=alias.p; echo `unset GIT_CONFIG_KEY_0`; git p origin main",
        "export GIT_CONFIG_KEY_0=alias.p; echo ';' unset GIT_CONFIG_KEY_0; git p origin main",
        "export GIT_CONFIG_KEY_0=alias.p # ; unset GIT_CONFIG_KEY_0\ngit p origin main",
        "if true; then GIT_CONFIG_KEY_0=alias.p git p origin main; fi",
        "GIT_CONFIG_KEY_0=$'alias.p' git p origin main",
        "GIT_CONFIG_KEY_0=alias.p git p origin main # '",
        "env -i GIT_CONFIG_KEY_0=alias.p env git p origin main",
        'export GIT_CONFIG_KEY_0=alias.p; echo "$(git p origin main)"',
        "export GIT_CONFIG_KEY_0=alias.p; echo `git p origin main`",
        'echo "$(GIT_CONFIG_KEY_0=alias.p git p origin main)"',
        "command env GIT_CONFIG_KEY_0=alias.p git p origin main",
        "exec env GIT_CONFIG_KEY_0=alias.p git p origin main",
        "command export GIT_CONFIG_KEY_0=alias.p; git p origin main",
        'env -S "GIT_CONFIG_KEY_0=alias.p git p origin main"',
        'export GIT_CONFIG_KEY_0=alias.p; env -S "git p origin main"',
        "GIT_CONFIG_KEY_0=alias.p 2>/dev/null git p origin main",
        "env GIT_CONFIG_KEY_0=alias.p >/dev/null git p origin main",
        ">/dev/null GIT_CONFIG_KEY_0=alias.p git p origin main",
        "export GIT_CONFIG_KEY_0=alias.p; unset -vf GIT_CONFIG_KEY_0; git p origin main",
        "export GIT_CONFIG_KEY_0=alias.p; readonly GIT_CONFIG_KEY_0; unset GIT_CONFIG_KEY_0; git p origin main",
        "GIT_CONFIG_KEY_0=alias.p export GIT_CONFIG_KEY_0; git p origin main",
        "export GIT_CONFIG_KEY_0=alias.p; cat <<EOF\nunset GIT_CONFIG_KEY_0\nEOF\ngit p origin main",
        `GIT_CONFIG_PARAMETERS="'user.name=x' 'Alias.P=push'" git p origin main`,
        `GIT_CONFIG_PARAMETERS="'alias.p'='push'" git p origin main`,
        "export GIT_CONFIG_KEY_0=alias.p; env -S 'git\\_p\\_origin\\_main'",
        "export GIT_CONFIG_KEY_0=alias.p; readonly GIT_CONFIG_KEY_0; GIT_CONFIG_KEY_0=user.name git p origin main",
        "export GIT_CONFIG_KEY_0=alias.p; readonly GIT_CONFIG_KEY_0; eval 'unset GIT_CONFIG_KEY_0; git p origin main'",
        "eval 'export GIT_CONFIG_KEY_0=alias.p'; git p origin main",
        "export GIT_CONFIG_KEY_0=alias.p; printf 'git p origin main' | sh",
        "export GIT_CONFIG_KEY_0=alias.p; sh <<< 'git p origin main'",
        "export GIT_CONFIG_KEY_0=alias.p; command -v unset GIT_CONFIG_KEY_0; git p origin main",
        "export GIT_CONFIG_KEY_0=alias.p; command -v export GIT_CONFIG_KEY_0=user.name; git p origin main",
        "export GIT_CONFIG_KEY_0=alias.p; declare -p GIT_CONFIG_KEY_0=user.name; git p origin main",
        "export GIT_CONFIG_KEY_0=alias.p; export -f GIT_CONFIG_KEY_0=user.name; git p origin main",
        "export GIT_CONFIG_KEY_0=alias.p; local GIT_CONFIG_KEY_0=user.name; git p origin main",
        "export GIT_CONFIG_KEY_0=alias.p; exec -a echo git p origin main",
        "export GIT_CONFIG_KEY_0=alias.p; xargs -I echo git p origin main <<< x",
        `export GIT_CONFIG_PARAMETERS=; GIT_CONFIG_PARAMETERS+="'alias.p=push'" git p origin main`,
        "export GIT_CONFIG_KEY_0=; GIT_CONFIG_KEY_0+=alias.p; git p origin main",
        "export GIT_CONFIG_KEY_0=alias.p; unset GIT_CONFIG_KEY_0 </dev/null/missing; git p origin main",
        'export GIT_CONFIG_KEY_0=alias.p; read"only" GIT_CONFIG_KEY_0; unset GIT_CONFIG_KEY_0; git p origin main',
        "export GIT_CONFIG_KEY_0=alias.p; bash -es arg <<< 'git p origin main'",
        "export GIT_CONFIG_KEY_0=alias.p; bash -c -o posix 'git p origin main'",
        "export GIT_CONFIG_KEY_0=alias.p; declare +p GIT_CONFIG_KEY_0=user.name; git p origin main",
        "env -iS 'GIT_CONFIG_KEY_0=alias.p git p origin main'",
        "export GIT_CONFIG_KEY_0=alias.p; enable -n unset; unset GIT_CONFIG_KEY_0; git p origin main",
        "set -o posix; GIT_CONFIG_KEY_0=alias.p :; export GIT_CONFIG_KEY_0; git p origin main",
        "export GIT_CONFIG_KEY_0=alias.p; printf 'gi\"\"t p origin main' | sh",
        "GIT_CONFIG_KEY_0=alias.p env -S 'git\\c' p origin main",
        "GIT_CONFIG_KEY_0=alias.p $'git' p origin main",
        "GIT_CONFIG_KEY_0=alias.p g$'it' p origin main",
        "printf '%s\\n' 'export GIT_CONFIG_KEY_0=alias.p' 'git p origin main' | bash",
        'exec -a "$0" env GIT_CONFIG_KEY_0=alias.p git p origin main',
        "export GIT_CONFIG_KEY_0=alias.p; bash /dev/stdin <<< 'git p origin main'",
        "env $'GIT_CONFIG_KEY_0=alias.p' git p origin main",
        'export G=git; env GIT_CONFIG_KEY_0=alias.p "$G" p origin main',
        'export CFG=GIT_CONFIG_KEY_0=alias.p; env "$CFG" git p origin main',
        "export GIT_CONFIG_KEY_0=alias.p; command -- git p origin main",
        "export GIT_CONFIG_KEY_0=alias.p; command -x unset GIT_CONFIG_KEY_0; git p origin main",
        "exec -a git env GIT_CONFIG_KEY_0=alias.p git p origin main",
      ])
        expect(reason(await guard(command, contents))).toContain(
          "git push [-u] [-q] origin <branch>",
        );

      expect(
        reason(await guard("GIT_CONFIG_KEY_0=alias.p git p --force origin main", contents)),
      ).toContain("force push");

      for (const command of [
        'rg "GIT_CONFIG_KEY_0=alias.p git p" docs',
        "echo GIT_CONFIG_KEY_0=alias.p && git status",
        "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=x git status",
        "GIT_CONFIG_COUNT=0 git status",
        "GIT_CONFIG_PARAMETERS= git status",
        "export GIT_CONFIG_KEY_0=alias.p; unset GIT_CONFIG_KEY_0; git status",
        "export GIT_CONFIG_KEY_0=alias.p",
        "GIT_CONFIG_KEY_0=alias.p make",
        "GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_KEY_0=user.name git status",
        "export GIT_CONFIG_KEY_0=alias.p; env -u GIT_CONFIG_KEY_0 git status",
        "export GIT_CONFIG_KEY_0=alias.p; GIT_CONFIG_KEY_0=user.name; git status",
        "git status; export GIT_CONFIG_KEY_0=alias.p",
        `GIT_CONFIG_PARAMETERS="'user.name=x'" git status`,
        "GIT_CONFIG_KEY_0=alias.p echo git",
        "export GIT_CONFIG_KEY_0=alias.p; rg git docs",
        "export GIT_CONFIG_KEY_0=alias.p; command -v git",
        "env $FOO ls",
        'export GIT_CONFIG_KEY_0=alias.p; printf "%s" "git"',
        `GIT_CONFIG_PARAMETERS="'user.name=an alias.person'" git status`,
        `GIT_CONFIG_PARAMETERS="'user.name'='alias.person'" git status`,
        `GIT_CONFIG_PARAMETERS="'alias.p=push'" sh -c 'env -u GIT_CONFIG_PARAMETERS git status'`,
        `GIT_CONFIG_PARAMETERS="'alias.p=push'" sh -c 'GIT_CONFIG_PARAMETERS= git status'`,
      ])
        expect(await guard(command, contents)).toBeNull();
    }
  });

  test("test_line_continuations_do_not_hide_a_push", async () => {
    const repo = await pushRepo();
    for (const command of [
      "git \\\npush --force origin main",
      "gi\\\nt push origin main",
      "cat <<EOF\nit's\nEOF\ngit \\\npush --force origin main",
    ])
      expect(reason(await guard(command, undefined, undefined, repo))).toContain(
        "git push [-u] [-q] origin <branch>",
      );

    expect(
      reason(await guard("cat <<EOF\nit's\nEOF\ngit config \\\nskills.greptile.rereviews 9")),
    ).toContain("skills.* holds the operator's reviewer settings");
  });

  test("test_ansi_c_quoted_subcommands_are_judged", async () => {
    const repo = await pushRepo();
    for (const contents of ["DELIVERY=prs\n", "DELIVERY=hands-off\n"]) {
      for (const command of [
        "git $'push' --force origin main",
        "git $'p'ush origin main",
        "git $'\\x70ush' --force origin main",
        "git $'\\160\\u0075sh' origin main",
        "git $'\\push' --force origin main",
        "git $'push\\0ignored' --force origin main",
        "git $'push\\C-@x' --force origin main",
        "git $'push\\c@x' --force origin main",
        ": $'\\U00110000'; git $'\\x70ush' --force origin main",
        "git $'push\\C-\\@ignored' --force origin main",
        "git $'pus\\C-\\U00000068' --force origin main",
        "git $'pus\\C-\\U00000068@ignored' --force origin main",
        "git $'pus\\C-\\u0068' --force origin main",
        "git $'pus\\C-\\u0068@ignored' --force origin main",
        "printf $'git \\u0070ush --force origin main' | sh",
      ])
        expect(reason(await guard(command, contents, undefined, repo))).toContain(
          "git push [-u] [-q] origin <branch>",
        );

      for (const command of [
        "git $'commit' --amend --no-edit",
        "git $'cherry-pick' abc1234",
        "git $'merge' feature",
        "git $'pull'",
        "git $'\\commit' --amend --no-edit",
        "git $'\\merge' feature",
        "git $'commit\\x00extra' --amend",
        "printf $'git merge feature' | sh",
        "printf $'git pull' | sh",
        "git $'commit\\C-\\x40ignored' --amend",
        "printf $'git \\u006derge feature' | sh",
      ])
        expect(reason(await guard(command, contents, undefined, repo))).toContain("git commit -m");

      for (const command of [
        "git $'pu\\0'sh origin main",
        "git $'push\\0'x origin main",
        "g''it $'pu\\0'sh --force origin main",
        "$'g\\x69t' $'push\\0'x --force origin main",
      ])
        expect(reason(await guard(command, contents, undefined, repo))).toContain(
          "could not be parsed",
        );

      expect(
        reason(
          await guard(
            "printf $'git \\u0063onfig skills.greptile false' | sh",
            contents,
            undefined,
            repo,
          ),
        ),
      ).toContain("skills.* holds the operator's reviewer settings");

      for (const command of [
        `rg "\\$'push'" README.md`,
        "git log --grep $'push'",
        "while IFS= read -r -d $'\\0' file; do echo \"$file\"; done < list",
      ])
        expect(await guard(command, contents, undefined, repo)).toBeNull();
    }
  });

  test("test_locale_quoted_subcommands_are_judged", async () => {
    const repo = await pushRepo();
    for (const contents of ["DELIVERY=prs\n", "DELIVERY=hands-off\n"]) {
      for (const command of ['git $"push" --force origin main', 'git $"p"ush origin main'])
        expect(reason(await guard(command, contents, undefined, repo))).toContain(
          "git push [-u] [-q] origin <branch>",
        );

      expect(
        reason(await guard('git $"commit" --amend --no-edit', contents, undefined, repo)),
      ).toContain("git commit -m");

      for (const command of ['git $"status"', "rg '$\"push\"' README.md"])
        expect(await guard(command, contents, undefined, repo)).toBeNull();
    }
  });

  test("test_substitutions_that_do_not_push_pass", async () => {
    const repo = await pushRepo();
    for (const command of [
      'git log --grep=push "$(git merge-base HEAD origin/main)"..HEAD',
      'rg "git push" "$(git rev-parse --show-toplevel)"',
      "git diff `git merge-base HEAD origin/main`",
    ])
      expect(await guard(command, undefined, undefined, repo)).toBeNull();
  });

  test("test_delivery_scripts_and_quoted_push_mentions_pass", async () => {
    for (const command of [
      '__BIN__ fix-round -P Skills -m "fix: guard git push" hooks/a.py',
      '__BIN__ fix-round -P Skills -m "fix: x" a',
      '__BIN__ publish -m "feat: x" a',
      '__BIN__ publish -m "feat: add git push guard" a',
      "__BIN__ lease-rebase feat/a abc123 feat/b",
      "__BIN__ restack-layer -P Skills --push",
      "__BIN__ restack-layer -P Skills",
      'SKILLS_OWN_ROWS="feat/a feat/b" __BIN__ lease-rebase feat/a abc123 feat/b',
      'rg "git push" README.md',
      'git log --grep="git push"',
    ])
      expect(await guard(command.replaceAll("__BIN__", bin))).toBeNull();
  });

  test("test_pr_comments", async () => {
    expect(
      await guard('gh pr comment 12 --body "@greptileai"', "DELIVERY=prs\nWITH=greptile\n"),
    ).toBeNull();

    for (const contents of ["DELIVERY=prs\n", "DELIVERY=hands-off\n"])
      expect(reason(await guard('gh pr comment 12 --body "@greptileai"', contents))).toContain(
        "gh pr comment <number>",
      );

    for (const command of [
      'gh pr comment 12 --body "@greptileai please"',
      'gh pr comment 12 -b "@greptileai"',
      "gh pr comment 12 --body-file f",
      'gh pr comment 12 --body "@greptileai" | cat',
      'echo x; gh pr comment 12 --body "@greptileai"',
      'gh pr comment 12 --body "$(echo @greptileai)"',
      'gh pr comment 12 --body "@greptileai" && true',
    ])
      expect(reason(await guard(command, "DELIVERY=prs\nWITH=greptile\n"))).toContain(
        "gh pr comment <number>",
      );
  });

  test("test_declared_reviewer_triggers", async () => {
    reviewer("testbot", declaration);
    const comment = (body: string, extensions: string) =>
      guard('gh pr comment 12 --body "' + body + '"', "DELIVERY=prs\nWITH=" + extensions + "\n");

    for (const body of ["@testbot review", "@greptileai"])
      expect(await comment(body, "greptile testbot")).toBeNull();

    expect(reason(await comment("@testbot review", "greptile"))).toContain("testbot is inactive");

    for (const body of ["@testbot", "@testbot review please", "hello", "@greptileai"])
      expect(reason(await comment(body, "testbot"))).toContain("gh pr comment <number>");

    writeFileSync(
      join(root, "testbot/reviewer.conf"),
      declaration.replace("TRIGGER=@testbot review\n", ""),
    );

    expect(reason(await comment("@testbot review", "greptile testbot"))).toContain("unreadable");
  });

  test("test_coderabbit_trigger", async () => {
    reviewer("coderabbit", readFileSync(join(repoRoot, "skills/coderabbit/reviewer.conf"), "utf8"));
    const comment = (body: string) =>
      guard('gh pr comment 12 --body "' + body + '"', "DELIVERY=prs\nWITH=coderabbit\n");

    expect(await comment("@coderabbitai review")).toBeNull();

    for (const body of [
      "@coderabbitai",
      "@coderabbitai full review",
      "@coderabbitai resolve",
      "@coderabbitai approve",
      "@coderabbitai review please",
      "@greptileai",
    ])
      expect(reason(await comment(body))).toContain("gh pr comment <number>");
  });

  test("test_passes_unguarded_commands_and_non_bash_tools", async () => {
    for (const command of [
      "git status",
      "git log --grep commit",
      "gh pr view 5",
      "ls -la",
      "gh stack add feat/c",
      "cat <<'EOF' > notes.md\nit's fine\nEOF",
    ])
      expect(await guard(command)).toBeNull();

    for (const payload of [
      { tool_name: "Write", tool_input: { command: "git commit" } },
      { tool_name: "Edit", tool_input: { file_path: "a.py" } },
    ])
      expect(await output(JSON.stringify(payload), "DELIVERY=hands-off\n")).toBeNull();
  });

  test("test_review_bypasses_are_denied", async () => {
    for (const [command, shape] of [
      ["echo feature#123; git commit -m bad", "git commit -m"],
      ["git --namespace foo commit -m bad", "git commit -m"],
      ["git --config-env user.name=USER commit -m bad", "git commit -m"],
      ["gh -R owner/repo pr comment 12 --body bad", "gh pr comment <number>"],
      ["gh pr -R owner/repo comment 12 --body bad", "gh pr comment <number>"],
    ])
      expect(reason(await guard(command!, "DELIVERY=prs\nWITH=greptile\n"))).toContain(shape!);
  });

  test("test_reviewer_setting_config_is_denied_in_any_case", async () => {
    for (const command of [
      "git config skills.greptile.rereviews 9",
      "git config set Skills.greptile.rereviews 9",
      "git -C . config --local SKILLS.Greptile.threshold 1",
      "git config --add skills.greptile.threshold 1",
      "git config --get skills.greptile.rereviews",
      "bash -c 'git config Skills.greptile.rereviews 9'",
      "echo ok; git config skills.greptile.rereviews 9",
      'git config "skills".greptile.rereviews 9',
      "git config 'skills.'greptile.rereviews 9",
      "git config s\\kills.greptile.rereviews 9",
      "git config \\\nskills.greptile.rereviews 9",
      'echo "$(git config skills.greptile.rereviews 9)"',
      'echo "git config skills.greptile.rereviews 9" | bash',
      "git config </dev/null skills.greptile.rereviews 9",
      "git config >|/dev/null skills.greptile.rereviews 9",
      "git $(printf config) skills.greptile.rereviews 9",
      "git $(printf config) 'skills.greptile.rereviews' 9",
      'git "$(printf config)" skills.greptile.rereviews 9',
      'git "`printf config`" skills.greptile.rereviews 9',
      'GIT=git; "$GIT" config skills.greptile.rereviews 9',
      'command "$GIT" config skills.greptile.rereviews 9',
      'exec "$GIT" config skills.greptile.rereviews 9',
      'env "$GIT" config skills.greptile.rereviews 9',
      "echo a\\\\\ngit config skills.greptile.rereviews 9",
      "# note\\\ngit config skills.greptile.rereviews 9",
      "echo hi # note\\\ngit config skills.greptile.rereviews 9",
      `echo $'\\'' && git "$(printf config)" skills.greptile.rereviews 9 #'`,
      `echo $'\\'' && echo "$(git config skills.greptile.rereviews 9)" #'`,
      `cat <<EOF\n'\nEOF\ngit "$(printf config)" skills.greptile.rereviews 9 #'`,
    ])
      expect(reason(await guard(command, "DELIVERY=prs\nWITH=greptile\n"))).toContain(
        "skills.* holds the operator's reviewer settings",
      );

    for (const command of [
      "git config --get branch.feat/x.skills-base",
      "git config user.name",
      "git log --grep skills.conf",
      "git status\nrg config skills.conf",
    ])
      expect(await guard(command)).toBeNull();
  });

  test("test_quoted_mentions_pass", async () => {
    for (const command of [
      'rg "git commit" README.md',
      'git log --grep="git commit"',
      'rg -n "gh pr comment" skills',
      'rg "git config skills.greptile" docs',
      'git log --grep="git config skills.greptile"',
      'echo "git config skills.greptile.rereviews 9"',
      'rg "git config skills.greptile" "$(pwd)/docs"',
      'rg "git config skills.greptile $(pwd)" docs',
      "rg 'git config skills.greptile $(pwd)' docs",
      'rg "$pattern" config skills.conf',
    ])
      expect(await guard(command)).toBeNull();
  });

  test("test_shell_stdin_counts_as_nested", async () => {
    for (const contents of ["DELIVERY=prs\n", "DELIVERY=hands-off\n"]) {
      for (const [command, text] of [
        ['echo "git push --force origin main" | bash', "git push [-u] [-q] origin <branch>"],
        ['echo "git push --force origin main" | cat | bash', "git push [-u] [-q] origin <branch>"],
        ['(echo "git push --force origin main"; echo ok) | bash', "git push [-u] [-q]"],
        ['printf "%s" "git push" ";" | bash', "git push [-u] [-q]"],
        ['echo "git push" |\ncat |\n\nbash', "git push [-u] [-q]"],
        ['echo "git push" | # note\nbash', "git push [-u] [-q]"],
        ['echo "git push" | (\nbash\n)', "git push [-u] [-q]"],
        ['echo "git push" | bash 3< run.sh', "git push [-u] [-q]"],
        ['echo "git push" | bash <(cat)', "git push [-u] [-q]"],
        ['bash -s 3 <<< "git push"', "git push [-u] [-q]"],
        ['(echo "git push"; echo ok > /dev/null) | bash', "git push [-u] [-q]"],
        ['echo "git push" 3>&1 > /dev/null >&3 | bash', "git push [-u] [-q]"],
        ['echo "git push" | bash < /dev/stdin', "git push [-u] [-q]"],
        ['echo "git push" | # note \\\nbash', "git push [-u] [-q]"],
        ["{ printf 'git '; echo push; } | bash", "git push [-u] [-q]"],
        ['echo "git push --force origin main" | (true; bash)', "git push [-u] [-q]"],
        ['echo "git push" | while read l; do bash; done', "git push [-u] [-q]"],
        ["printf 'x\\ngit push' | bash", "git push [-u] [-q]"],
        ['echo "git push" | tee >(bash)', "git push [-u] [-q]"],
        ['echo "git push" | rg --hostname-bin bash x', "git push [-u] [-q]"],
        ['true | (printf "git push" | bash)', "git push [-u] [-q]"],
        ['rg x | head; echo "git push" | (true; bash)', "git push [-u] [-q]"],
        ['echo "git push" | case a in a) bash;; esac', "git push [-u] [-q]"],
        ["printf g$'it push --force origin main' | sh", "git push [-u] [-q]"],
        ["sh <<< g$'it'\\ push", "git push [-u] [-q]"],
        ["printf g$'it push --force origin main' | b$'ash'", "git push [-u] [-q]"],
        ["printf '%s%s\\n' g$'i' 't push --force origin main' | sh", "git push [-u] [-q]"],
        ["command printf '%s%s\\n' gi 't push --force origin main' | sh", "git push [-u] [-q]"],
        ["printf '%.*s%s\\n' 2 gix 't push --force origin main' | sh", "git push [-u] [-q]"],
        ["printf '%.*s%s\\n' +2 gix 't push' | sh", "git push [-u] [-q]"],
        ["printf '%.*b%s\\n' 2 '\\0147\\0151x' 't push' | sh", "git push [-u] [-q]"],
        [`printf g$'it push' | $${"\\\n".repeat(63)}"bash"`, "git push [-u] [-q]"],
        ["printf g$'it push --force origin main' | $\\\n\"bash\"", "git push [-u] [-q]"],
        ["printf '%s' g$'it commit --amend' | bash", "nested command"],
        [
          'sh -c "git push"; sh -c "git config skills.greptile.rereviews 9"',
          "skills.* holds the operator's reviewer settings",
        ],
        ['bash <<< "git commit --amend --no-edit"', "nested command"],
        ['{ echo "git commit --amend"; echo ok; } | sh', "nested command"],
        ["printf 'gh pr comment 5 --body hi' | sh", "nested command"],
        [
          'echo "git config skills.greptile.rereviews 9" | sh',
          "skills.* holds the operator's reviewer settings",
        ],
        [
          'eval "git config" "skills.greptile.rereviews 9"',
          "skills.* holds the operator's reviewer settings",
        ],
      ])
        expect(reason(await guard(command!, contents))).toContain(text!);

      for (const command of [
        "echo 'git push'; echo bash",
        'echo "git push" > notes.txt; bash build.sh',
        'rg "git commit" README.md | head',
        'echo "git config skills.greptile.rereviews 9"; echo sh',
        'echo "git push" || bash',
        "cat run.sh | bash",
        'rg "git push" docs | rg bash',
        'echo "git push"; (true; bash)',
        'rg "git push" docs | head; (true; bash build.sh)',
        "printf g$'it push' > notes.txt",
        'echo "git push" # | sh',
        "printf 'git push' # | sh\nsh -c ':'",
        "printf 'git push'; printf '# %s\\n' ')' | sh",
      ])
        expect(await guard(command, contents)).toBeNull();
    }
  });

  test("test_xargs_git_counts_as_nested", async () => {
    for (const contents of ["DELIVERY=prs\n", "DELIVERY=hands-off\n"]) {
      for (const [command, text] of [
        ["printf 'push --force origin main' | xargs git", "git push [-u] [-q] origin <branch>"],
        [
          "printf '%s\\n' push --force origin main | xargs git",
          "git push [-u] [-q] origin <branch>",
        ],
        ["echo push | xargs -I{} git {} --force origin main", "git push [-u] [-q] origin <branch>"],
        ["xargs git <<EOF\npush --force origin main\nEOF", "git push [-u] [-q] origin <branch>"],
        ["printf '%s\\n' status push | xargs -n1 git", "git push [-u] [-q] origin <branch>"],
        ["echo 'push origin feat/x' | xargs git 2>/dev/null", "git push [-u] [-q] origin <branch>"],
        ["echo push | xargs git # note", "git push [-u] [-q] origin <branch>"],
        ["echo push | xargs -I';' git ';'", "git push [-u] [-q] origin <branch>"],
        ["echo push |\nxargs git", "git push [-u] [-q] origin <branch>"],
        ["echo 'status push' | xargs -L2 -n1 git", "git push [-u] [-q] origin <branch>"],
        ["echo 'status push' | xargs -s15 git", "git push [-u] [-q] origin <branch>"],
        ["echo push | command xargs env git", "git push [-u] [-q] origin <branch>"],
        ["echo push | xargs -I{} -n1 git {}", "git push [-u] [-q] origin <branch>"],
        ["echo push | command -- env xargs git", "git push [-u] [-q] origin <branch>"],
        ["echo push | xargs git 3<&0 0<&3", "git push [-u] [-q] origin <branch>"],
        ["xargs git <<A <<B\nstatus\nA\npush\nB", "git push [-u] [-q] origin <branch>"],
        ["xargs -n 1 <<< push git", "git push [-u] [-q] origin <branch>"],
        ["xargs git 3<<< push <<< status 0<&3", "git push [-u] [-q] origin <branch>"],
        ["xargs git <<A; xargs git <<B\nstatus\nA\npush\nB", "git push [-u] [-q] origin <branch>"],
        ["echo push | xargs -n 1 >/dev/null 2>/dev/null git", "git push [-u] [-q] origin <branch>"],
        ["echo push | exec -a name xargs git", "git push [-u] [-q] origin <branch>"],
        ["echo push | exec -aa xargs git", "git push [-u] [-q] origin <branch>"],
        ["printf 'pu%sh --force origin main' s | xargs git", "git push [-u] [-q] origin <branch>"],
        ["printf '%cush' please | xargs git", "git push [-u] [-q] origin <branch>"],
        ["printf push | xargs -d , -E push git", "git push [-u] [-q] origin <branch>"],
        [
          "printf '%s,' -c 'foo.bar=one two three' push | xargs -d , -n3 git",
          "git push [-u] [-q] origin <branch>",
        ],
        ["echo push | xargs git -C 2 > /dev/null", "git push [-u] [-q] origin <branch>"],
        ["xargs git <<push <<EOF\nstatus\npush\npush\nEOF", "git push [-u] [-q] origin <branch>"],
        [
          "printf 'push,--force,origin,main' | xargs -d , git",
          "git push [-u] [-q] origin <branch>",
        ],
        [
          "xargs git -C <<EOF\n/tmp\n-c foo.bar=baz\n-c foo.baz=qux\npush\nEOF",
          "git push [-u] [-q] origin <branch>",
        ],
        ["xargs git <<A; :\npush\nA", "git push [-u] [-q] origin <branch>"],
        [
          "echo push | xargs -n 1 >/dev/null 2>/dev/null 3>/dev/null 4>/dev/null 5>/dev/null 6>/dev/null 7>/dev/null git",
          "git push [-u] [-q] origin <branch>",
        ],
        [
          "cat <<push >/dev/null\nignored\npush\nxargs git <<EOF\npush\nEOF",
          "git push [-u] [-q] origin <branch>",
        ],
        [
          'xargs -n 2>/dev/null 1 git <<< "push --force origin main"',
          "git push [-u] [-q] origin <branch>",
        ],
        ["xargs -n 2\\\n>/dev/null 1 git <<< push", "git push [-u] [-q] origin <branch>"],
        ["xargs {fd}>/dev/null git <<< push", "git push [-u] [-q] origin <branch>"],
        ["{ echo status; echo push; } | xargs -n1 git", "git push [-u] [-q] origin <branch>"],
        ["{ printf 'push\\n'; } | xargs git", "git push [-u] [-q] origin <branch>"],
        ["(echo status; echo push) | xargs -n1 git", "git push [-u] [-q] origin <branch>"],
        [
          "{ (echo status) && echo push\necho ok; } | xargs -n1 git",
          "git push [-u] [-q] origin <branch>",
        ],
        ["{ printf pu; printf sh; } | xargs git", "git push [-u] [-q] origin <branch>"],
        ["{ echo -n pu; echo sh; } | xargs git", "git push [-u] [-q] origin <branch>"],
        [
          "{ printf pu || printf noise; printf sh; } | xargs git",
          "git push [-u] [-q] origin <branch>",
        ],
        [
          "{ echo status >/dev/null; echo push; } | xargs git",
          "git push [-u] [-q] origin <branch>",
        ],
        ["{ echo status >&2; echo push; } | xargs git", "git push [-u] [-q] origin <branch>"],
        ["{ echo push >/dev/stdout; echo x; } | xargs git", "git push [-u] [-q] origin <branch>"],
        ["{ echo push >&2; echo x; } |& xargs git", "git push [-u] [-q] origin <branch>"],
        ["{ echo push >&2; echo x; } 2>&1 | xargs git", "git push [-u] [-q] origin <branch>"],
        [
          "{ echo status >notes.txt; echo push; } | xargs git",
          "git push [-u] [-q] origin <branch>",
        ],
        ["{ printf '%Q' || echo push; } | xargs git", "git push [-u] [-q] origin <branch>"],
        ["{ echo push <>/dev/null; } | xargs git", "git push [-u] [-q] origin <branch>"],
        [
          "{ printf pu; printf noise 01>/dev/null; printf sh; } | xargs git",
          "git push [-u] [-q] origin <branch>",
        ],
        [
          "{ printf pu; printf noise 1<&2; printf sh; } | xargs git",
          "git push [-u] [-q] origin <branch>",
        ],
        ["{ echo push 2>&1 >&2; } | xargs git", "git push [-u] [-q] origin <branch>"],
        ["{ printf pu extra; printf sh; } | xargs git", "git push [-u] [-q] origin <branch>"],
        ["{ echo 'pu\\c'; echo sh; } | xargs git", "git push [-u] [-q] origin <branch>"],
        ["xargs -n 2&>/dev/null 1 git <<< push", "git push [-u] [-q] origin <branch>"],
        ["echo x | xargs -n 1&>/dev/null git push", "git push [-u] [-q] origin <branch>"],
        ["{ echo push & } | xargs git", "git push [-u] [-q] origin <branch>"],
        ["echo push | xargs parallel git :::", "git push [-u] [-q] origin <branch>"],
        ['xargs git <<< "commit --amend --no-edit"', "nested command"],
        [
          'echo "config skills.greptile.rereviews 9" | xargs git',
          "skills.* holds the operator's reviewer settings",
        ],
      ])
        expect(reason(await guard(command!, contents))).toContain(text!);

      for (const command of [
        "xargs -n 2 >/dev/null 1 git <<< push",
        `xargs -n1 git add <<< "${Array.from({ length: 1100 }, (_, index) => `f${index}.ts`).join(" ")}"`,
        'xargs -n "2">/dev/null 1 git <<< push',
        "{ echo a.ts; echo b.ts; } | xargs git add",
        "{ echo status; echo push; } | xargs echo git",
        "{ echo push; } > notes.txt; xargs git status <<< a.ts",
        "git ls-files -m | xargs git add",
        'rg -l "git push" docs | xargs git add',
        "echo README.md | xargs git add",
        "printf 'status --short' | xargs git",
        'echo "push --force origin main" | xargs echo git',
        "echo 'push --force origin main'; echo xargs git",
        'rg "git push" docs | xargs wc -l',
        "echo status push | xargs -L1 git",
        "echo push | xargs -E push git",
        "xargs git add <<EOF\na.ts\nEOF\necho push",
        "echo 'push origin feat/x' | xargs -I{} git {}",
        "printf 'a.ts,b c.ts' | xargs -d , git add",
      ])
        expect(await guard(command, contents)).toBeNull();
    }
  });

  test("test_parallel_git_counts_as_nested", async () => {
    const words = (count: number, prefix = "a") =>
      Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(" ");

    const many = words(40);
    const inner = (prefix: string) =>
      `parallel git ::: ${words(30, prefix)} ::: ${words(30, prefix)}`;

    for (const contents of ["DELIVERY=prs\n", "DELIVERY=hands-off\n"]) {
      for (const [command, text] of [
        ["parallel git ::: push", "git push [-u] [-q] origin <branch>"],
        ["parallel git {} --force origin main ::: push", "git push [-u] [-q] origin <branch>"],
        ["echo push | parallel git", "git push [-u] [-q] origin <branch>"],
        ["parallel ::: 'git push --force origin main'", "git push [-u] [-q] origin <branch>"],
        ["parallel ::: git ::: push", "git push [-u] [-q] origin <branch>"],
        ["parallel -j 4 -k git ::: push", "git push [-u] [-q] origin <branch>"],
        ["parallel --jobs=4 --joblog jobs.log git ::: push", "git push [-u] [-q] origin <branch>"],
        ["parallel git {2} {1} ::: origin ::: push", "git push [-u] [-q] origin <branch>"],
        ["parallel git :::+ status push :::+ -v --force", "git push [-u] [-q] origin <branch>"],
        ["parallel --colsep ' ' git ::: 'push origin main'", "git push [-u] [-q] origin <branch>"],
        [`parallel --csv git ::: '"push",origin'`, "git push [-u] [-q] origin <branch>"],
        ["parallel -N2 git -C ::: x y . push", "git push [-u] [-q] origin <branch>"],
        ["parallel git {.} ::: push.x", "git push [-u] [-q] origin <branch>"],
        ["parallel git {/.} ::: /tmp/push.x", "git push [-u] [-q] origin <branch>"],
        ["parallel -I XX git XX ::: push", "git push [-u] [-q] origin <branch>"],
        ["parallel --arg-sep ,, git ,, push", "git push [-u] [-q] origin <branch>"],
        ["parallel git <<< push", "git push [-u] [-q] origin <branch>"],
        ["parallel git <<EOF\nstatus\npush\nEOF", "git push [-u] [-q] origin <branch>"],
        ["{ echo status; echo push; } | parallel git", "git push [-u] [-q] origin <branch>"],
        ["echo push | parallel git :::: -", "git push [-u] [-q] origin <branch>"],
        ["parallel git ::: push :::: list.txt", "git push [-u] [-q] origin <branch>"],
        ["env_parallel git ::: push", "git push [-u] [-q] origin <branch>"],
        ["command parallel env git ::: push", "git push [-u] [-q] origin <branch>"],
        ["parallel 'git push; echo' ::: x", "git push [-u] [-q] origin <branch>"],
        ["parallel sh -c ::: 'git push'", "git push [-u] [-q] origin <branch>"],
        ["parallel git {= $_='push' =} ::: x", "replacement string could not be read"],
        ["parallel --plus git {/x/push} ::: x", "replacement string could not be read"],
        [`parallel git ::: ${many} ::: ${many}`, "too many commands to judge"],
        [`parallel sh -c ::: "${inner("a")}" "${inner("b")}"`, "nested command"],
        ["parallel --tag git ::: push", "git push [-u] [-q] origin <branch>"],
        ["printf push | parallel -d '' git", "empty parallel delimiter could not be read"],
        [
          "printf 'x\\nx\\0z\\0.\\0push\\0' | parallel -0 -N2 git -C",
          "git push [-u] [-q] origin <branch>",
        ],
        ["parallel -s 99 -N2 git -C ::: x y . push", "git push [-u] [-q] origin <branch>"],
        ["parallel -N2 -n1 git '{2}' ::: x push", "git push [-u] [-q] origin <branch>"],
        ["printf ',push' | parallel -d , -0 -N2 git '{2}'", "git push [-u] [-q] origin <branch>"],
        ["parallel git '{1:%.4s}' ::: push-extra", "replacement string could not be read"],
        ["parallel --match 'x(.*)' git '{1.1}' ::: xpush", "replacement string could not be read"],
        ["parallel --rpl 'V $_=1' V push ::: x", "replacement string could not be read"],
        ["parallel gh pr '{= $_=1 =}' 12 --body hi ::: x", "replacement string could not be read"],
        [
          "parallel --xapplyinputsource 1 '{}' ::: 'git push'",
          "git push [-u] [-q] origin <branch>",
        ],
        ["parallel -N2 git '{-2}' ::: push x y z", "git push [-u] [-q] origin <branch>"],
        ["parallel --colsep , git '{2}' ::: 'a, push'", "git push [-u] [-q] origin <branch>"],
        ["parallel --colsep '\\t' git '{2}' ::: $'a\\tpush'", "git push [-u] [-q] origin <branch>"],
        ["printf ',push' | parallel -d , -N2 git '{2}'", "git push [-u] [-q] origin <branch>"],
        ["parallel git {//} ::: push//a", "git push [-u] [-q] origin <branch>"],
        [`parallel --csv git '{3}' ::: '"a,b",x,push'`, "git push [-u] [-q] origin <branch>"],
        ["parallel '{}' ::: 'git push --force origin main'", "git push [-u] [-q] origin <branch>"],
        [
          "parallel --parens '[]' 'g[ s/x/it/ ]' push ::: x",
          "replacement string could not be read",
        ],
        ["parallel --plus 'sh -c {/x/git push}' ::: x", "replacement string could not be read"],
        ["parallel git '{1}' ::: push :::", "git push [-u] [-q] origin <branch>"],
        ["parallel git '{2}' :::: list.txt ::: push", "git push [-u] [-q] origin <branch>"],
        ["parallel -N2 git '{3}' ::: x push ::: y z", "git push [-u] [-q] origin <branch>"],
        ["parallel --colsep , git '{2}' ::: ',push'", "git push [-u] [-q] origin <branch>"],
        ["parallel --colsep '[,;]' git '{2}' ::: 'a;push'", "git push [-u] [-q] origin <branch>"],
        ["parallel --trim lr git ::: ' push '", "git push [-u] [-q] origin <branch>"],
        ["parallel --group --link git ::: push ::: x", "git push [-u] [-q] origin <branch>"],
        ["printf 'status\\0push' | parallel -0 git", "git push [-u] [-q] origin <branch>"],
        ["printf 'status,push' | parallel -d , git", "git push [-u] [-q] origin <branch>"],
        ["parallel -i XX git XX ::: push", "git push [-u] [-q] origin <branch>"],
        ["parallel git {-1} ::: x ::: push", "git push [-u] [-q] origin <branch>"],
        ["parallel git {0} ::: push", "git push [-u] [-q] origin <branch>"],
        ["parallel 'git {= $_=\"push\" =}' ::: x", "replacement string could not be read"],
        ["parallel g{= $_='it' =} push ::: x", "replacement string could not be read"],
        ["parallel --header : git {x} ::: x push", "replacement string could not be read"],
        ["parallel git ::: commit", "nested command"],
        [
          "parallel git config ::: skills.greptile.rereviews ::: 9",
          "skills.* holds the operator's reviewer settings",
        ],
      ])
        expect(reason(await guard(command!, contents))).toContain(text!);

      for (const command of [
        "parallel echo ::: push",
        'rg "parallel git" README.md',
        "parallel echo ::: 'git push --force origin main'",
        "parallel -N2 echo ::: 'git push' --force",
        "parallel --tag echo ::: 'git push --force origin main'",
        "parallel 'echo {}' ::: 'git push --force origin main'",
        "parallel -N2 git -C ::: . status push log",
        "parallel --colsep , git '{1}' ::: 'log -1,file'",
        "{ echo push >&2; echo a.ts; } | xargs git",
        "parallel --colsep , echo ::: 'git,status'",
        "parallel echo {.} ::: push.x",
        "parallel gzip ::: a.log b.log",
        "parallel git add ::: a.ts b.ts",
        "echo a.ts | parallel git add",
        "parallel git :::: list.txt",
        "parallel -a list.txt git",
        `parallel echo ::: ${many}`,
      ])
        expect(await guard(command, contents)).toBeNull();
    }
  });

  test("test_unparseable_commit_is_denied", async () => {
    expect(reason(await guard('git commit -m "feat: x'))).toContain("could not be parsed");
  });

  test("test_codex_list_commands", async () => {
    expect(await guard(["bash", "-lc", "git commit -m 'feat: x'"])).toBeNull();
    expect(reason(await guard(["git", "commit", "--amend", "--no-edit"]))).toContain(
      "git commit -m",
    );
  });

  test("test_fails_closed", async () => {
    expect(reason(await output("not json", undefined, { AGENT_HOOKS: "0" }))).toContain(
      "payload was unreadable",
    );

    expect(
      reason(await guard('git commit -m "feat: x"', "DELIVERY=hands-off\n", { AGENT_HOOKS: "0" })),
    ).toContain("hands-off mode");

    expect(
      reason(
        await guard('gh pr comment 12 --body "@greptileai"', "DELIVERY=prs\n", {
          AGENT_HOOKS: "0",
        }),
      ),
    ).toContain("greptile is inactive");
  });

  test("CLI registration and fatal stdin decoding", async () => {
    writeFileSync(conf, "DELIVERY=prs\n");
    const payloads = [
      JSON.stringify({ tool_input: { command: 'git commit -m "a" -m "b"' } }),
      JSON.stringify({ tool_input: { command: "ls" } }),
      '\ufeff{"tool_input":{"command":"ls"}}',
      Uint8Array.of(0xff),
    ];

    for (const input of payloads) {
      const child = Bun.spawn([bin, "--root", root, "hook", "pre-tool-use"], {
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });

      child.stdin.write(input);
      child.stdin.end();
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      expect(code).toBe(0);
      expect(stderr).toBe("");

      if (input === payloads[1]) expect(stdout).toBe("");
      else if (typeof input === "string" && input === payloads[0])
        expect(stdout).toBe(await guardOutput(input, root, env));
      else expect(reason(JSON.parse(stdout))).toContain("payload was unreadable");
    }
  });

  test("PR numbers require ASCII digits and command guards fail closed", async () => {
    for (const number of ["\u00b2", "\u1369", "\u{1f100}", "\u0661\u0662"])
      expect(
        reason(
          await guard(
            "gh pr comment " + number + ' --body "@greptileai"',
            "DELIVERY=prs\nWITH=greptile\n",
          ),
        ),
      ).toContain("PR comment is not a reviewer trigger");

    for (const command of [
      "g\u0131t conf\u0130g sk\u0131lls.x 1",
      "git config skills.\u0131 1",
      "git config skills.\u0130 1",
      "git config \u017fkills.x 1",
    ])
      expect(classify(command).kind).toBe("DENY_SETTING");

    expect(await guard([])).toBeNull();
    expect(await guard(["git", "commit", "-m", "feat: it's"])).toBeNull();
    expect(await guard(["bash/", "-lc", "git commit -m 'feat: x'"])).toBeNull();
    expect(reason(await guard(["git", "push", "origin", "feat/\u001cbranch"]))).toContain(
      "unsupported push",
    );

    expect(reason(await guard('git push origin "feat/\ufeffbranch"'))).toContain(
      "unsupported push",
    );
  });

  test("hands-off extensions and malformed configuration fail closed", async () => {
    const { readDelivery } = await import("../delivery.ts");
    reviewer("testbot", declaration);
    writeFileSync(join(root, "testbot/SKILL.md"), "---\noptional: true\n---\n");
    expect(
      reason(
        await guard(
          'gh pr comment 12 --body "@testbot review"',
          "DELIVERY=hands-off\nWITH=testbot\n",
        ),
      ),
    ).toContain("testbot is inactive");

    expect(readDelivery(root, env).active).toContain("testbot");

    expect(reason(await guard('git commit -m "feat: x"', "DELIVERY=prs\nBAD LINE\n"))).toContain(
      "hands-off mode",
    );
  });

  test("PASS does not read configuration, declarations or git", async () => {
    const missing = join(temporary, "missing");
    const unreadableEnv = new Proxy(env, {
      get() {
        throw new Error("environment was read");
      },
    });

    expect(
      await guardOutput(
        JSON.stringify({ tool_input: { command: "ls -la && git status" }, cwd: missing }),
        missing,
        unreadableEnv,
      ),
    ).toBe("");
  });

  test("cwd failures deny only when the payload needs a fallback", async () => {
    const directory = await pushRepo();
    const cwd = spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("cwd was removed");
    });

    try {
      expect(
        await output(JSON.stringify({ tool_input: { command: "ls" }, cwd: temporary })),
      ).toBeNull();

      expect(
        await output(
          JSON.stringify({ tool_input: { command: "git push origin feat/x" }, cwd: directory }),
        ),
      ).toBeNull();

      expect(reason(await output(JSON.stringify({ tool_input: { command: "ls" } })))).toContain(
        "payload was unreadable",
      );
    } finally {
      cwd.mockRestore();
    }
  });
});

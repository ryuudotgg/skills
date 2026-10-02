import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fixtureGit } from "../test/fixtures.ts";
import { classify, guardOutput } from "./pre-tool-use.ts";

const repoRoot = resolve(import.meta.dir, "../..");
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

  async function pushRepo(withHead = true): Promise<string> {
    fixtureId++;
    const repo = join(temporary, "repo-" + fixtureId);
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

  test("test_line_continuations_do_not_hide_a_push", async () => {
    const repo = await pushRepo();
    for (const command of ["git \\\npush --force origin main", "gi\\\nt push origin main"])
      expect(reason(await guard(command, undefined, undefined, repo))).toContain(
        "git push [-u] [-q] origin <branch>",
      );
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
    ])
      expect(reason(await guard(command, "DELIVERY=prs\nWITH=greptile\n"))).toContain(
        "skills.* holds the operator's reviewer settings",
      );

    for (const command of [
      "git config --get branch.feat/x.skills-base",
      "git config user.name",
      "git log --grep skills.conf",
    ])
      expect(await guard(command)).toBeNull();
  });

  test("test_quoted_mentions_pass", async () => {
    for (const command of [
      'rg "git commit" README.md',
      'git log --grep="git commit"',
      'rg -n "gh pr comment" skills',
    ])
      expect(await guard(command)).toBeNull();
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

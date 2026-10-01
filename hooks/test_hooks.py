import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest


HERE = os.path.dirname(os.path.abspath(__file__))
GIT = ["git", "-c", "user.email=t@t", "-c",
       "user.name=t", "-c", "commit.gpgsign=false"]


def hook(script, payload, env=None):
  e = dict(os.environ, AGENT_HOOKS="1")
  e.pop("AGENT_HOOKS_SKIP", None)
  e.update(env or {})
  r = subprocess.run([sys.executable, "-B", os.path.join(HERE, script)], input=json.dumps(payload),
                     capture_output=True, text=True, env=e)
  assert r.returncode == 0, r.stderr
  return json.loads(r.stdout) if r.stdout.strip() else None


def put(path, text):
  with open(path, "w") as f:
    f.write(text)


class ReplyGuard(unittest.TestCase):
  def setUp(self):
    self.tmp = tempfile.mkdtemp()
    self.repo = os.path.join(self.tmp, "repo")
    os.makedirs(self.repo)
    subprocess.run(GIT + ["init", "-q"], cwd=self.repo, check=True)
    subprocess.run(GIT + ["commit", "-q", "--allow-empty",
                   "-m", "init"], cwd=self.repo, check=True)

  def stop(self, message, **extra):
    payload = {"hook_event_name": "Stop", "session_id": "s1", "cwd": self.repo,
               "scratchpad_dir": self.tmp, "last_assistant_message": message, **extra}
    return hook("reply_guard.py", payload)

  def test_clean_reply_passes(self):
    self.assertIsNone(self.stop(
      "Done. The hook blocks on dashes and `a -- b` in code is fine.\n\n```\nx \u2014 y\n```"))

  def test_dash_blocks(self):
    self.assertIn("dash", self.stop(
      "The key moved \u2014 one switch drives both.")["reason"])
    self.assertIn("dash", self.stop(
      "The key moved - one switch drives both.")["reason"])

  def test_list_bullets_are_not_dashes(self):
    self.assertIsNone(self.stop("Changes:\n- moved the key\n- added a row\n"))

  def test_filler_and_labels_block(self):
    out = self.stop("Great question! **Performance:** it improved.")
    self.assertIn("Great question", out["reason"])
    self.assertIn("bold label", out["reason"])

  def test_drafted_reply_prose_passes(self):
    message = (
      "https://github.com/o/r/pull/12#discussion_r99\n"
      "```text\n"
      "This is intended. Outside a git repo there's no root to judge from, so a file you name on the command line gets formatted instead of being silently dropped because a directory on its path is called dist or build. Directory scans still skip dist below the argument, and inside a repo an explicitly named file under dist or node_modules is still skipped, since it's judged from the repo root. Tests for both cases are in 14ca3f1.\n"
      "```"
    )

    self.assertIsNone(self.stop(message))

  def draft(self, body, closing="```"):
    return f"https://github.com/o/r/pull/12#discussion_r99\n```text\n{body}\n{closing}"

  def test_drafted_reply_paths_block(self):
    for token in ("tests/files.test.ts", "dist/a.ts", "~/Plans", "src/main.ts:42"):
      with self.subTest(token=token):
        self.assertIn(token, self.stop(self.draft(f"See {token}."))["reason"])

  def test_drafted_reply_closing_fence_may_trail_spaces(self):
    reason = self.stop(self.draft("See dist/a.ts.", closing="```  ") + "\n\n```ts\nx\n```")["reason"]
    self.assertIn("dist/a.ts", reason)
    self.assertNotIn("backtick", reason)

  def test_text_block_without_thread_is_not_a_draft(self):
    self.assertIsNone(self.stop("Changed files:\n```text\nsrc/main.ts \u2014 `x`\n```"))

  def test_drafted_reply_plan_id_blocks(self):
    for body in ("It lands in the Hooks batch (plan 090).", "Plans 89 and 90 cover it.", "See Plan #29.",
                 "See plan#29.", "It lands in the batch plan\n090 covers."):
      with self.subTest(body=body):
        self.assertIn("plan id", self.stop(self.draft(body))["reason"])

  def test_plan_id_outside_draft_passes(self):
    self.assertIsNone(self.stop("Plan 089 is done."))

  def test_drafted_reply_plan_word_passes(self):
    for body in ("The plan was 2 steps, both in 14ca3f1.", "The service plans 3 retries."):
      with self.subTest(body=body):
        self.assertIsNone(self.stop(self.draft(body)))

  def test_unsaved_state_lets_rewrites_through(self):
    blocker = os.path.join(self.tmp, "not-a-dir")
    put(blocker, "")
    unwritable = os.path.join(blocker, "scratch")
    self.assertIn("dash", self.stop("x \u2014 y", scratchpad_dir=unwritable)["reason"])
    self.assertIsNone(self.stop("x \u2014 y", scratchpad_dir=unwritable, stop_hook_active=True))

  def test_malformed_state_still_checks(self):
    for state in ("null", '{"seen": 1}', '{"rewrites": "x"}', "3"):
      with self.subTest(state=state):
        put(os.path.join(self.tmp, "reply-guard-s1.json"), state)
        self.assertIn("dash", self.stop("x \u2014 y")["reason"])

  def test_drafted_reply_backtick_blocks(self):
    self.assertIn("backtick", self.stop(self.draft("Use `code`."))["reason"])

  def test_drafted_reply_urls_are_not_paths(self):
    self.assertIsNone(self.stop(self.draft("See https://github.com/o/r/pull/12 for context.")))

  def test_drafted_reply_reports_each_prose_rule_once(self):
    message = "Outside \u2014 prose.\n" + self.draft("First \u2014 draft.") + "\n" + self.draft("Second \u2014 draft.")
    self.assertEqual(self.stop(message)["reason"].count("a dash used as punctuation"), 1)

  def test_drafted_reply_dash_blocks(self):
    self.assertIn("dash", self.stop(self.draft("This moved \u2014 it works."))["reason"])

  def test_draft_blockquote_under_pr_link_blocks(self):
    for line in ("https://github.com/o/r/pull/12", "Thread https://github.com/o/r/pull/12#discussion_r9 says"):
      with self.subTest(line=line):
        self.assertIn("```text", self.stop(f"{line}\n\n> This is the reply.")["reason"])

  def test_blockquote_without_pr_link_passes(self):
    self.assertIsNone(self.stop("> This is a quotation."))

  def test_other_fences_stay_exempt(self):
    for fence in ("```", "```ts"):
      with self.subTest(fence=fence):
        self.assertIsNone(self.stop(
          f"{fence}\ntests/files.test.ts \u2014 still code\n```"))

  def test_tree_comments_reported_once(self):
    path = os.path.join(self.repo, "a.ts")
    put(path, "// added by a delegate\nconst a = 1;\n")
    out = self.stop("Done.")
    self.assertIn("added by a delegate", out["reason"])
    self.assertIsNone(self.stop("Done."))

  def test_tracked_file_only_added_lines(self):
    path = os.path.join(self.repo, "b.py")
    put(path, "# old comment\nx = 1\n")
    subprocess.run(GIT + ["add", "b.py"], cwd=self.repo, check=True)
    subprocess.run(GIT + ["commit", "-q", "-m", "b"], cwd=self.repo, check=True)
    put(path, "# old comment\nx = 1\n# new comment\ny = 2\n")
    out = self.stop("Done.")
    self.assertIn("new comment", out["reason"])
    self.assertNotIn("old comment", out["reason"])

  def git(self, *args):
    return subprocess.run(GIT + list(args), cwd=self.repo, capture_output=True,
                          text=True, check=True).stdout.strip()

  def commit_file(self, name, text):
    put(os.path.join(self.repo, name), text)
    self.git("add", name)
    self.git("commit", "-q", "-m", name)

  def branch_from_main(self, name, base=None):
    self.git("branch", "-M", "main")
    self.git("checkout", "-q", "-b", name)
    if base:
      self.git("config", f"branch.{name}.skills-base", base)

  def track_origin_main(self):
    self.git("branch", "-M", "main")
    self.git("update-ref", "refs/remotes/origin/main", self.git("rev-parse", "HEAD"))
    self.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")

  def test_committed_comment_since_recorded_base_is_reported(self):
    self.branch_from_main("feat/x", base="main")
    self.commit_file("delegate.py", "# committed by a delegate\n")
    self.assertIn("committed by a delegate", self.stop("Done.")["reason"])

  def test_parent_layer_comment_below_recorded_base_is_not_reported(self):
    self.branch_from_main("feat/parent")
    self.commit_file("parent.py", "# parent layer comment\n")
    self.git("checkout", "-q", "-b", "feat/child")
    self.git("config", "branch.feat/child.skills-base", "feat/parent")
    self.commit_file("child.py", "# child layer comment\n")

    reason = self.stop("Done.")["reason"]
    self.assertIn("child layer comment", reason)
    self.assertNotIn("parent layer comment", reason)

  def test_without_recorded_base_uses_remote_default_merge_base(self):
    self.track_origin_main()
    self.git("checkout", "-q", "-b", "feat/y")
    self.commit_file("without_base.py", "# committed without base\n")
    self.assertIn("committed without base", self.stop("Done.")["reason"])

  def test_on_default_branch_committed_comments_stay_hidden(self):
    self.track_origin_main()
    self.commit_file("main.py", "# committed on main\n")
    self.assertIsNone(self.stop("Done."))

  def test_outside_a_repository_reports_nothing(self):
    outside = tempfile.mkdtemp()
    self.addCleanup(shutil.rmtree, outside)
    put(os.path.join(outside, "stray.py"), "# stray comment\n")
    payload = {"hook_event_name": "Stop", "session_id": "outside", "cwd": outside,
               "scratchpad_dir": self.tmp, "last_assistant_message": "Done."}

    self.assertIsNone(hook("reply_guard.py", payload))

  def test_subdirectory_cwd_still_scans_tree(self):
    sub = os.path.join(self.repo, "pkg")
    os.makedirs(sub)
    put(os.path.join(sub, "c.ts"), "// deep comment\nexport {};\n")
    payload = {"hook_event_name": "Stop", "session_id": "s2", "cwd": sub,
               "scratchpad_dir": self.tmp, "last_assistant_message": "Done."}
    self.assertIn("pkg/c.ts:1", hook("reply_guard.py", payload)["reason"])

  def test_only_displayed_findings_are_marked_seen(self):
    put(os.path.join(self.repo, "many.py"), "".join(
      f"# c{i}\n" for i in range(12)) + "x = 1\n")
    first = self.stop("Done.")["reason"]
    self.assertIn("and 4 more", first)
    second = self.stop("Done.")["reason"]
    self.assertIn("c11", second)
    self.assertNotIn("c0 ", second)

  def test_non_ascii_path_and_rename_are_scanned(self):
    put(os.path.join(self.repo, "caf\u00e9.ts"), "// accent path\nexport {};\n")
    put(os.path.join(self.repo, "old.py"), "x = 1\n")
    subprocess.run(GIT + ["add", "old.py"], cwd=self.repo, check=True)
    subprocess.run(GIT + ["commit", "-q", "-m", "old"],
                   cwd=self.repo, check=True)
    subprocess.run(GIT + ["mv", "old.py", "new.py"], cwd=self.repo, check=True)
    put(os.path.join(self.repo, "new.py"), "x = 1\n# added during move\n")
    subprocess.run(GIT + ["add", "new.py"], cwd=self.repo, check=True)
    reason = self.stop("Done.")["reason"]
    self.assertIn("accent path", reason)
    self.assertIn("added during move", reason)

  def test_rewrite_after_a_block_is_checked(self):
    self.assertIn("dash", self.stop("x \u2014 y")["reason"])
    self.assertIn("plan id", self.stop(self.draft("It lands in plan 090."), stop_hook_active=True)["reason"])

  def test_rewrites_stop_blocking_at_the_cap(self):
    self.stop("x \u2014 y")
    self.stop("x \u2014 y", stop_hook_active=True)
    self.assertIsNone(self.stop("x \u2014 y", stop_hook_active=True))

  def test_clean_rewrite_resets_the_cap(self):
    self.stop("x \u2014 y")
    self.stop("x \u2014 y", stop_hook_active=True)
    self.assertIsNone(self.stop("Done.", stop_hook_active=False))
    self.assertIn("dash", self.stop("x \u2014 y")["reason"])


class CommitGuard(unittest.TestCase):
  def setUp(self):
    self.tmp = tempfile.mkdtemp()
    self.addCleanup(shutil.rmtree, self.tmp)
    self.home = os.path.join(self.tmp, "home")
    os.makedirs(self.home)
    self.fixture_id = 0

  def fixture(self, with_mode_script=True, extra_reviewers=None):
    self.fixture_id += 1
    root = os.path.join(self.tmp, f"fixture-{self.fixture_id}")
    hooks = os.path.join(root, "hooks")
    os.makedirs(hooks)
    for name in ("commit-guard.sh", "commit_guard.py"):
      shutil.copy(os.path.join(HERE, name), hooks)
    if with_mode_script:
      scripts = os.path.join(root, "skills", "playbook", "scripts")
      os.makedirs(scripts)
      for name in ("delivery-mode.sh", "extension-verdict.sh", "reviewers.sh"):
        shutil.copy(os.path.join(HERE, "..", "skills", "playbook", "scripts", name),
                    scripts)
      greptile = os.path.join(root, "skills", "greptile")
      os.makedirs(greptile)
      put(os.path.join(greptile, "SKILL.md"),
          "---\nname: greptile\ndescription: Greptile review loop.\n"
          "optional: true\nrequires: prs\n---\n")
      shutil.copy(os.path.join(HERE, "..", "skills", "greptile", "reviewer.conf"),
                  greptile)

      for name, declaration in (extra_reviewers or {}).items():
        directory = os.path.join(root, "skills", name)
        os.makedirs(directory)
        put(os.path.join(directory, "SKILL.md"),
            f"---\nname: {name}\ndescription: Reviewer extension.\n"
            "optional: true\nrequires: prs\n---\n")
        put(os.path.join(directory, "reviewer.conf"), declaration)

    return os.path.join(hooks, "commit-guard.sh")

  def guard(self, command, conf="DELIVERY=prs\n", env=None, with_mode_script=True, cwd=None):
    path = os.path.join(self.tmp, "skills.conf")
    put(path, conf)
    environment = dict(os.environ, HOME=self.home, SKILLS_CONF=path, AGENT_HOOKS="1")
    environment.pop("AGENTS_DIR", None)
    environment.update(env or {})
    payload = {"hook_event_name": "PreToolUse", "tool_name": "Bash",
               "tool_input": {"command": command}}
    if cwd is not None:
      payload["cwd"] = cwd
    result = subprocess.run(["bash", self.fixture(with_mode_script)], input=json.dumps(payload),
                            capture_output=True, text=True, env=environment)
    self.assertEqual(result.returncode, 0, result.stderr)
    return json.loads(result.stdout) if result.stdout.strip() else None

  def reason(self, output):
    return output["hookSpecificOutput"]["permissionDecisionReason"]

  def push_repo(self, with_head=True):
    self.fixture_id += 1
    repo = os.path.join(self.tmp, f"repo-{self.fixture_id}")
    origin = os.path.join(self.tmp, f"origin-{self.fixture_id}.git")
    os.makedirs(repo)
    subprocess.run(GIT + ["init", "-q", "-b", "main"], cwd=repo, check=True)
    subprocess.run(GIT + ["commit", "-q", "--allow-empty", "-m", "init"], cwd=repo,
                   check=True)
    subprocess.run(GIT + ["checkout", "-q", "-b", "feat/x"], cwd=repo, check=True)
    subprocess.run(["git", "init", "-q", "--bare", origin], check=True)
    subprocess.run(["git", "remote", "add", "origin", origin], cwd=repo, check=True)
    subprocess.run(["git", "update-ref", "refs/remotes/origin/main", "HEAD"], cwd=repo,
                   check=True)
    if with_head:
      subprocess.run(["git", "symbolic-ref", "refs/remotes/origin/HEAD",
                      "refs/remotes/origin/main"], cwd=repo, check=True)
    return repo

  def test_allowed_commits_in_prs_mode(self):
    fifty = "feat: " + "x" * 44
    cases = [
      'git commit -m "feat: add guard"',
      "git -C /tmp/x commit -m 'fix(hooks): x'",
      'git commit --message="feat: y"',
      'gh stack add -m "chore: z"',
      'gh stack add feat/b -m "docs: w"',
      f'git commit -m "{fifty}"',
    ]
    for command in cases:
      with self.subTest(command=command):
        self.assertIsNone(self.guard(command))

  def test_denied_commits(self):
    fifty_one = "feat: " + "x" * 45
    cases = [
      f'git commit -m "{fifty_one}"',
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
      'bash -c "git commit -m \'feat: x\'"',
    ]
    for command in cases:
      with self.subTest(command=command):
        output = self.guard(command)
        self.assertIsNotNone(output)
        self.assertIn("git commit -m", self.reason(output))

  def test_hands_off_denies_every_allowed_commit(self):
    cases = [
      'git commit -m "feat: add guard"',
      "git -C /tmp/x commit -m 'fix(hooks): x'",
      'git commit --message="feat: y"',
      'gh stack add -m "chore: z"',
      'gh stack add feat/b -m "docs: w"',
    ]
    for command in cases:
      with self.subTest(command=command):
        output = self.guard(command, "DELIVERY=hands-off\n")
        self.assertIn("hands-off mode", self.reason(output))
        self.assertIn("git commit -m", self.reason(output))

  def test_allowed_typed_pushes_in_prs_mode(self):
    repo = self.push_repo()
    cases = [
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
    ]
    for command in cases:
      with self.subTest(command=command):
        self.assertIsNone(self.guard(command, cwd=repo))

    outside = os.path.join(self.tmp, "outside")
    os.makedirs(outside)
    self.assertIsNone(self.guard(f"git -C {repo} push -u origin feat/x", cwd=outside))
    self.assertIsNone(self.guard(f"git -C {os.path.basename(repo)} push -u origin feat/x",
                                 cwd=self.tmp))

  def test_typed_pushes_outside_the_allowed_shape_are_denied(self):
    repo = self.push_repo()
    shape = "git push [-u] [-q] origin <branch>"
    cases = [
      "git push -f origin feat/x", "git push -fu origin feat/x", "git push -uf origin feat/x",
      "git push --force origin feat/x", "git push --force-with-lease origin feat/x",
      "git push --force-with-lease=feat/x origin feat/x",
      "git push --force-with-lease=feat/x:abc123 origin feat/x",
      "git push --force-if-includes origin feat/x", "git push origin +feat/x",
      "git push origin refs/heads/*:refs/heads/*", "git push origin feat/x feat/y",
      "git push --mirror origin", "git push --all origin", "git push --prune origin feat/x",
      "git push --delete origin feat/x", "git push -d origin feat/x", "git push origin :feat/x",
      "git push", "git push origin", "git -c push.default=current push origin feat/x",
      "git -c alias.p=push p origin feat/x", "git send-pack origin feat/x", "gh stack push",
      "gh stack sync", "gh stack submit --auto --open", "gh stack link",
      "git push origin feat/x && true", "git push origin feat/x | cat",
      'echo "$(git push origin feat/x)"', "echo `git push origin feat/x`",
      'bash -c "git push origin feat/x"', "sh -c 'git push -f origin feat/x'",
    ]
    for command in cases:
      with self.subTest(command=command):
        reason = self.reason(self.guard(command, cwd=repo))
        self.assertIn(shape, reason)
        self.assertRegex(reason, r"skills publish|skills fix-round|skills lease-rebase|skills restack-layer")

  def test_hands_off_denies_every_allowed_typed_push(self):
    repo = self.push_repo()
    cases = ["git push origin feat/x", "git push -u origin feat/x",
             "git push -q origin feat/x", "git push -u -q origin feat/x",
             "git push -q -u origin feat/x",
             "git push origin refs/heads/feat/x:refs/heads/feat/x",
             "git push -u origin refs/heads/feat/x:refs/heads/feat/x",
             "git push -q origin refs/heads/feat/x:refs/heads/feat/x",
             "git push -u -q origin refs/heads/feat/x:refs/heads/feat/x",
             "git push -q -u origin refs/heads/feat/x:refs/heads/feat/x"]
    for command in cases:
      with self.subTest(command=command):
        self.assertIn("hands-off mode", self.reason(
          self.guard(command, "DELIVERY=hands-off\n", cwd=repo)))

    outside = os.path.join(self.tmp, "outside")
    os.makedirs(outside)
    self.assertIn("hands-off mode", self.reason(self.guard(
      f"git -C {repo} push -u origin feat/x", "DELIVERY=hands-off\n", cwd=outside)))
    self.assertIn("hands-off mode", self.reason(self.guard(
      f"git -C {os.path.basename(repo)} push -u origin feat/x", "DELIVERY=hands-off\n",
      cwd=self.tmp)))

  def test_default_branch_typed_pushes_are_denied(self):
    repo = self.push_repo()
    outside = os.path.join(self.tmp, "outside")
    os.makedirs(outside)
    for command, cwd in (("git push origin main", repo),
                         ("git push origin refs/heads/main:refs/heads/main", repo),
                         (f"git -C {repo} push origin main", outside)):
      with self.subTest(command=command):
        self.assertIn("main is the default branch", self.reason(self.guard(command, cwd=cwd)))

  def test_typed_push_needs_origin_head_and_a_local_branch(self):
    no_head = self.push_repo(with_head=False)
    self.assertIn("git remote set-head origin -a", self.reason(
      self.guard("git push origin feat/x", cwd=no_head)))

    repo = self.push_repo()
    self.assertIn("not a local branch", self.reason(
      self.guard("git push origin feat/y", cwd=repo)))

  def test_remapped_push_destination_needs_the_explicit_refspec(self):
    repo = self.push_repo()
    subprocess.run(["git", "config", "remote.origin.push", "refs/heads/feat/x:refs/heads/main"],
                   cwd=repo, check=True)
    self.assertIn("remote.origin.push", self.reason(
      self.guard("git push origin feat/x", cwd=repo)))
    self.assertIsNone(self.guard("git push origin refs/heads/feat/x:refs/heads/feat/x", cwd=repo))

  def test_line_continuations_do_not_hide_a_push(self):
    repo = self.push_repo()
    for command in ("git \\\npush --force origin main", "gi\\\nt push origin main"):
      with self.subTest(command=command):
        self.assertIn("git push [-u] [-q] origin <branch>", self.reason(
          self.guard(command, cwd=repo)))

  def test_substitutions_that_do_not_push_pass(self):
    repo = self.push_repo()
    for command in ('git log --grep=push "$(git merge-base HEAD origin/main)"..HEAD',
                    'rg "git push" "$(git rev-parse --show-toplevel)"',
                    "git diff `git merge-base HEAD origin/main`"):
      with self.subTest(command=command):
        self.assertIsNone(self.guard(command, cwd=repo))

  def test_delivery_scripts_and_quoted_push_mentions_pass(self):
    bin = os.path.abspath(os.path.join(HERE, "..", "skills", "playbook", "bin", "skills"))
    cases = [
      f'{bin} fix-round -P Skills -m "fix: guard git push" hooks/a.py',
      f'{bin} fix-round -P Skills -m "fix: x" a',
      f'{bin} publish -m "feat: x" a',
      f'{bin} publish -m "feat: add git push guard" a',
      f'{bin} lease-rebase feat/a abc123 feat/b',
      f'{bin} restack-layer -P Skills --push',
      f'{bin} restack-layer -P Skills',
      f'SKILLS_OWN_ROWS="feat/a feat/b" {bin} lease-rebase feat/a abc123 feat/b',
      'rg "git push" README.md', 'git log --grep="git push"',
    ]
    for command in cases:
      with self.subTest(command=command):
        self.assertIsNone(self.guard(command))

  def test_pr_comments(self):
    allowed = self.guard('gh pr comment 12 --body "@greptileai"',
                       "DELIVERY=prs\nWITH=greptile\n")
    self.assertIsNone(allowed)

    for conf in ("DELIVERY=prs\n", "DELIVERY=hands-off\n"):
      with self.subTest(conf=conf):
        output = self.guard('gh pr comment 12 --body "@greptileai"', conf)
        self.assertIn("gh pr comment <number>", self.reason(output))

    cases = [
      'gh pr comment 12 --body "@greptileai please"',
      'gh pr comment 12 -b "@greptileai"',
      "gh pr comment 12 --body-file f",
      'gh pr comment 12 --body "@greptileai" | cat',
      'echo x; gh pr comment 12 --body "@greptileai"',
      'gh pr comment 12 --body "$(echo @greptileai)"',
      'gh pr comment 12 --body "@greptileai" && true',
    ]
    for command in cases:
      with self.subTest(command=command):
        output = self.guard(command, "DELIVERY=prs\nWITH=greptile\n")
        self.assertIn("gh pr comment <number>", self.reason(output))

  def test_declared_reviewer_triggers(self):
    declaration = ("NAME=TestBot\nLOGINS=testbot testbot[bot]\nHANDLES=@testbot\n"
                   "TRIGGER=@testbot review\nCHECK=TestBot\n")
    script = self.fixture(extra_reviewers={"testbot": declaration})
    path = os.path.join(self.tmp, "skills.conf")
    environment = dict(os.environ, HOME=self.home, SKILLS_CONF=path, AGENT_HOOKS="1")
    environment.pop("AGENTS_DIR", None)

    def comment(body, extensions):
      put(path, f"DELIVERY=prs\nWITH={extensions}\n")
      payload = {"tool_name": "Bash", "tool_input": {
        "command": f'gh pr comment 12 --body "{body}"',
      }}
      result = subprocess.run(["bash", script], input=json.dumps(payload),
                              capture_output=True, text=True, env=environment)

      self.assertEqual(result.returncode, 0, result.stderr)
      return json.loads(result.stdout) if result.stdout.strip() else None

    for body in ("@testbot review", "@greptileai"):
      with self.subTest(body=body):
        self.assertIsNone(comment(body, "greptile testbot"))

    self.assertIn("testbot is inactive", self.reason(comment("@testbot review", "greptile")))

    for body in ("@testbot", "@testbot review please", "hello", "@greptileai"):
      with self.subTest(body=body):
        self.assertIn("gh pr comment <number>", self.reason(comment(body, "testbot")))

    directory = os.path.join(os.path.dirname(script), "..", "skills", "testbot")
    put(os.path.join(directory, "reviewer.conf"), declaration.replace("TRIGGER=@testbot review\n", ""))
    self.assertIn("unreadable", self.reason(comment("@testbot review", "greptile testbot")))

  def test_coderabbit_trigger(self):
    declaration_path = os.path.abspath(os.path.join(
      HERE, "..", "skills", "coderabbit", "reviewer.conf"))
    with open(declaration_path, encoding="utf-8") as source:
      declaration = source.read()

    script = self.fixture(extra_reviewers={"coderabbit": declaration})
    path = os.path.join(self.tmp, "skills.conf")
    put(path, "DELIVERY=prs\nWITH=coderabbit\n")
    environment = dict(os.environ, HOME=self.home, SKILLS_CONF=path, AGENT_HOOKS="1")
    environment.pop("AGENTS_DIR", None)

    def comment(body):
      payload = {"tool_name": "Bash", "tool_input": {
        "command": f'gh pr comment 12 --body "{body}"',
      }}
      result = subprocess.run(["bash", script], input=json.dumps(payload),
                              capture_output=True, text=True, env=environment)

      self.assertEqual(result.returncode, 0, result.stderr)
      return json.loads(result.stdout) if result.stdout.strip() else None

    self.assertIsNone(comment("@coderabbitai review"))

    for body in ("@coderabbitai", "@coderabbitai full review", "@coderabbitai resolve",
                 "@coderabbitai approve", "@coderabbitai review please", "@greptileai"):
      with self.subTest(body=body):
        self.assertIn("gh pr comment <number>", self.reason(comment(body)))

  def test_passes_unguarded_commands_and_non_bash_tools(self):
    for command in ("git status", "git log --grep commit", "gh pr view 5", "ls -la",
                    "gh stack add feat/c", "cat <<'EOF' > notes.md\nit's fine\nEOF"):
      with self.subTest(command=command):
        self.assertIsNone(self.guard(command))

    path = os.path.join(self.tmp, "skills.conf")
    put(path, "DELIVERY=hands-off\n")
    environment = dict(os.environ, HOME=self.home, SKILLS_CONF=path, AGENT_HOOKS="1")
    for payload in ({"tool_name": "Write", "tool_input": {"command": "git commit"}},
                    {"tool_name": "Edit", "tool_input": {"file_path": "a.py"}}):
      with self.subTest(payload=payload):
        result = subprocess.run(["bash", self.fixture()], input=json.dumps(payload),
                                capture_output=True, text=True, env=environment)
        self.assertEqual(result.stdout, "")

  def test_review_bypasses_are_denied(self):
    cases = [
      ("echo feature#123; git commit -m bad", "git commit -m"),
      ("git --namespace foo commit -m bad", "git commit -m"),
      ("git --config-env user.name=USER commit -m bad", "git commit -m"),
      ("gh -R owner/repo pr comment 12 --body bad", "gh pr comment <number>"),
      ("gh pr -R owner/repo comment 12 --body bad", "gh pr comment <number>"),
    ]
    for command, shape in cases:
      with self.subTest(command=command):
        output = self.guard(command, "DELIVERY=prs\nWITH=greptile\n")
        self.assertIn(shape, self.reason(output))

  def test_reviewer_setting_config_is_denied_in_any_case(self):
    for command in ("git config skills.greptile.rereviews 9",
                    "git config set Skills.greptile.rereviews 9",
                    "git -C . config --local SKILLS.Greptile.threshold 1",
                    "git config --add skills.greptile.threshold 1",
                    "git config --get skills.greptile.rereviews",
                    "bash -c 'git config Skills.greptile.rereviews 9'",
                    "echo ok; git config skills.greptile.rereviews 9"):
      with self.subTest(command=command):
        output = self.guard(command, "DELIVERY=prs\nWITH=greptile\n")
        self.assertIn("skills.* holds the operator's reviewer settings", self.reason(output))

    for command in ("git config --get branch.feat/x.skills-base", "git config user.name",
                    "git log --grep skills.conf"):
      with self.subTest(command=command):
        self.assertIsNone(self.guard(command))

  def test_quoted_mentions_pass(self):
    for command in ('rg "git commit" README.md', 'git log --grep="git commit"',
                    'rg -n "gh pr comment" skills'):
      with self.subTest(command=command):
        self.assertIsNone(self.guard(command))

  def test_unparseable_commit_is_denied(self):
    output = self.guard("git commit -m \"feat: x")
    self.assertIn("could not be parsed", self.reason(output))

  def test_codex_list_commands(self):
    self.assertIsNone(self.guard(["bash", "-lc", "git commit -m 'feat: x'"]))
    output = self.guard(["git", "commit", "--amend", "--no-edit"])
    self.assertIn("git commit -m", self.reason(output))

  def test_fails_closed(self):
    path = os.path.join(self.tmp, "skills.conf")
    put(path, "DELIVERY=prs\n")
    environment = dict(os.environ, HOME=self.home, SKILLS_CONF=path, AGENT_HOOKS="0")
    result = subprocess.run(["bash", self.fixture()], input="not json", capture_output=True,
                            text=True, env=environment)
    unreadable = json.loads(result.stdout)
    self.assertIn("payload was unreadable", self.reason(unreadable))

    hands_off = self.guard('git commit -m "feat: x"', "DELIVERY=hands-off\n",
                         {"AGENT_HOOKS": "0"})
    self.assertIn("hands-off mode", self.reason(hands_off))
    inactive = self.guard('gh pr comment 12 --body "@greptileai"', "DELIVERY=prs\n",
                        {"AGENT_HOOKS": "0"})
    self.assertIn("greptile is inactive", self.reason(inactive))

    missing = self.guard('git commit -m "feat: x"', with_mode_script=False)
    self.assertIn("hands-off mode", self.reason(missing))


if __name__ == "__main__":
  unittest.main()

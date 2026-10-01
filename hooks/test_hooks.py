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


if __name__ == "__main__":
  unittest.main()

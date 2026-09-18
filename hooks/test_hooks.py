import json
import os
import subprocess
import sys
import tempfile
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


def write(tool, path, **fields):
  return {"hook_event_name": "PostToolUse", "tool_name": tool,
          "tool_input": {"file_path": path, **fields}}


def on_disk(tool, name, file_text, **fields):
  d = tempfile.mkdtemp()
  path = os.path.join(d, name)
  put(path, file_text)
  if tool == "Write":
    fields = {"content": file_text}
  return hook("no_comments.py", write(tool, path, **fields))


class NoComments(unittest.TestCase):
  def test_write_with_narration_blocks(self):
    out = hook("no_comments.py", write("Write", "/repo/src/a.ts",
               content="// Phase 1: add cards\nconst a = 1;\n"))
    self.assertEqual(out["decision"], "block")
    self.assertIn("Phase 1", out["reason"])

  def test_clean_write_passes(self):
    self.assertIsNone(hook("no_comments.py", write("Write", "/repo/src/a.ts",
                      content="const a = 1;\nconst url = 'http://x/y'; // not a comment line\n")))

  def test_edit_flags_only_new_comment_lines(self):
    out = hook("no_comments.py", write("Edit", "/repo/src/a.py",
               old_string="# kept\nx = 1\n", new_string="# kept\n# added here\nx = 2\n"))
    self.assertIn("added here", out["reason"])
    self.assertNotIn("kept", out["reason"])

  def test_block_comment_body_counts(self):
    out = hook("no_comments.py", write("Write", "/repo/src/a.ts",
               content="/**\n * Returns the thing.\n */\nexport function f() {}\n"))
    self.assertEqual(
      len([l for l in out["reason"].splitlines() if l.startswith("  ")]), 3)

  def test_pragmas_shebang_license_pass(self):
    content = ("#!/usr/bin/env python3\n# noqa: E501\n# type: ignore\n"
               "# SPDX-License-Identifier: MIT\n# Copyright (c) 2026 Ryuu\nx = 1\n")
    self.assertIsNone(hook("no_comments.py", write(
      "Write", "/repo/a.py", content=content)))
    ts = "// eslint-disable-next-line no-console\n// @ts-expect-error bun accepts duplex\nconsole.log(1)\n"
    self.assertIsNone(
      hook("no_comments.py", write("Write", "/repo/a.ts", content=ts)))

  def test_jsx_and_html_markers(self):
    out = hook("no_comments.py", write("Write", "/repo/a.tsx",
               content="<div>\n  {/* header */}\n</div>\n"))
    self.assertIn("header", out["reason"])
    out = hook("no_comments.py", write("Write", "/repo/a.html",
               content="<!-- nav -->\n<nav></nav>\n"))
    self.assertIn("nav", out["reason"])

  def test_prose_and_vendored_skip(self):
    self.assertIsNone(hook("no_comments.py", write(
      "Write", "/repo/README.md", content="# Title\n")))
    self.assertIsNone(hook("no_comments.py", write(
      "Write", "/repo/node_modules/x/a.js", content="// x\n")))

  def test_string_contents_are_not_comments(self):
    ts = "const sample = `\n// not a comment\n# nor this\n`;\nconst x = 1;\n"
    self.assertIsNone(
      hook("no_comments.py", write("Write", "/repo/a.ts", content=ts)))
    py = 'DOC = """\n# heading in a string\n"""\nx = 1\n'
    self.assertIsNone(
      hook("no_comments.py", write("Write", "/repo/a.py", content=py)))
    py2 = "x = 1 << 3\n# after a shift\n"
    self.assertIn("after a shift", hook("no_comments.py", write(
      "Write", "/repo/b.py", content=py2))["reason"])
    sh = "cat > f <<'EOF'\n# inside heredoc\nEOF\n# real comment\n"
    out = hook("no_comments.py", write("Write", "/repo/a.sh", content=sh))
    self.assertIn("real comment", out["reason"])
    self.assertNotIn("inside heredoc", out["reason"])

  def test_edit_reads_lexical_context_from_disk(self):
    file_text = "const t = `\n// example after\n`;\n/*\n * body line\n */\nconst x = 1;\n"
    out = on_disk("Edit", "a.ts", file_text,
                  old_string="// example before", new_string="// example after")
    self.assertIsNone(out)
    out = on_disk("Edit", "a.ts", file_text,
                  old_string=" * old body", new_string=" * body line")
    self.assertIn("body line", out["reason"])

  def test_fences_inside_quotes_and_comments_do_not_open_strings(self):
    ts = "const tick = '`';\n// real one\nconst s = \"it's\"; // has ` in trailing comment\n// second real\n"
    out = hook("no_comments.py", write("Write", "/repo/a.ts", content=ts))
    self.assertIn("real one", out["reason"])
    self.assertIn("second real", out["reason"])

  def test_multiline_pragma_block_exempt_as_a_whole(self):
    ts = ("/* eslint-disable\n   no-console,\n   no-alert */\n"
          "/** @type {import('vite').UserConfig} */\nexport default {};\n// narration\n")
    out = hook("no_comments.py", write("Write", "/repo/a.ts", content=ts))
    self.assertIn("narration", out["reason"])
    self.assertNotIn("no-alert", out["reason"])
    self.assertNotIn("@type", out["reason"])

  def test_backtick_in_block_comment_does_not_open_string(self):
    ts = "/* uses ` here\n * body */\nconst a = 1;\n// real one\n"
    self.assertIn("real one", hook("no_comments.py", write(
      "Write", "/repo/a.ts", content=ts))["reason"])

  def test_license_block_exempt_as_a_whole(self):
    ts = "/*\n * Copyright (c) 2026 Ryuu\n * MIT\n */\nexport const a = 1;\n// narration\n"
    out = hook("no_comments.py", write("Write", "/repo/a.ts", content=ts))
    self.assertIn("narration", out["reason"])
    self.assertNotIn("Copyright", out["reason"])
    self.assertNotIn("*/", out["reason"])

  def test_kill_switch(self):
    self.assertIsNone(hook("no_comments.py", write("Write", "/repo/a.ts", content="// x\n"),
                      env={"AGENT_HOOKS": "0"}))


class CodexPayloads(unittest.TestCase):
  def patch(self, body, cwd):
    return {"hook_event_name": "PostToolUse", "tool_name": "apply_patch", "cwd": cwd,
            "tool_input": {"command": "*** Begin Patch\n" + body + "*** End Patch"}}

  def test_apply_patch_add_file_flags_added_comment(self):
    d = tempfile.mkdtemp()
    put(os.path.join(d, "hello.py"), "# prints hi\nprint('hi')\n")
    body = "*** Add File: hello.py\n+# prints hi\n+print('hi')\n"
    out = hook("no_comments.py", self.patch(body, d))
    self.assertIn("hello.py: # prints hi", out["reason"])

  def test_apply_patch_update_only_new_lines(self):
    d = tempfile.mkdtemp()
    put(os.path.join(d, "a.ts"), "// kept\n// fresh\nconst a = 2;\n")
    body = ("*** Update File: " + os.path.join(d, "a.ts") + "\n@@\n // kept\n-const a = 1;\n"
            "+// fresh\n+const a = 2;\n")
    out = hook("no_comments.py", self.patch(body, d))
    self.assertIn("fresh", out["reason"])
    self.assertNotIn("kept", out["reason"])

  def test_apply_patch_delete_and_clean_pass(self):
    d = tempfile.mkdtemp()
    body = "*** Delete File: gone.py\n*** Add File: b.py\n+x = 1\n"
    put(os.path.join(d, "b.py"), "x = 1\n")
    self.assertIsNone(hook("no_comments.py", self.patch(body, d)))

  def test_em_dash_hook_reads_apply_patch(self):
    d = tempfile.mkdtemp()
    put(os.path.join(d, "notes.md"), "a \u2014 b\n")
    body = "*** Add File: notes.md\n+a \u2014 b\n"
    out = hook("no_em_dash.py", self.patch(body, d))
    self.assertIn("notes.md contains an em dash", out["reason"])
    self.assertIsNone(hook("no_em_dash.py", write(
      "Write", os.path.join(d, "none.md"), content="x")))


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

  def test_stop_hook_active_passes(self):
    self.assertIsNone(self.stop("x \u2014 y", stop_hook_active=True))


if __name__ == "__main__":
  unittest.main()

import ast
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

import apply_patch
import comment_scan

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
  def test_unclosed_jsx_block_reports_only_opener(self):
    text = "{/* keep */ }\nexport default function App() {}\nconst x = 1;\n"
    found = comment_scan.comment_lines(text, comment_scan.BY_EXT[".tsx"])
    self.assertEqual([line for _, line in found], ["{/* keep */ }"])

  def test_lua_block_comment_reports_its_span(self):
    text = "local a = 1\n--[[ narration\nstill narration\n]]\nlocal b = 2\n"
    found = comment_scan.comment_lines(text, comment_scan.BY_EXT[".lua"])
    self.assertEqual([line for _, line in found],
                     ["--[[ narration", "still narration", "]]"])

  def test_haskell_block_comment_reports_its_span(self):
    text = "x = 1\n{- narration\nstill narration\n-}\ny = 2\n"
    found = comment_scan.comment_lines(text, comment_scan.BY_EXT[".hs"])
    self.assertEqual([line for _, line in found],
                     ["{- narration", "still narration", "-}"])

  def test_php_attribute_is_not_a_comment(self):
    text = "#[Route(\"/home\")]\n# narration\n"
    found = comment_scan.comment_lines(text, comment_scan.BY_EXT[".php"])
    self.assertEqual([line for _, line in found], ["# narration"])

  def test_haskell_language_pragma_is_not_a_comment(self):
    text = "{-# LANGUAGE OverloadedStrings #-}\n"
    found = comment_scan.comment_lines(text, comment_scan.BY_EXT[".hs"])
    self.assertEqual(found, [])

  def test_comment_lines_only_reports_comment_spans(self):
    with open(__file__) as f:
      tree = ast.parse(f.read())
    texts = [node.value for node in ast.walk(tree)
             if isinstance(node, ast.Constant) and isinstance(node.value, str)
             and "\n" in node.value]
    specs = set(comment_scan.BY_EXT.values()) | set(
      comment_scan.BY_NAME.values())
    total = 0
    for text in texts:
      for spec in specs:
        markers, blocks = spec.markers, spec.blocks
        spans = set()
        lines = text.split("\n")
        i = 0
        while i < len(lines):
          stripped = lines[i].strip()
          pair = next(((opener, closer) for opener, closer in blocks
                       if stripped.startswith(opener)), None)
          if pair is None or pair[1] in stripped[len(pair[0]):]:
            i += 1
            continue
          end = next((j for j in range(i + 1, len(lines))
                     if pair[1] in lines[j]), i)
          spans.update(range(i + 1, end + 2))
          i = end + 1
        found = comment_scan.comment_lines(text, spec)
        total += len(found)
        for n, line in found:
          self.assertTrue(
            line.startswith(markers) or
            line.startswith(tuple(opener for opener, _ in blocks)) or
            n in spans,
            (text, spec, n, line))
    self.assertGreater(total, 0)

  def test_dangling_block_openers_do_not_report_source(self):
    spec = comment_scan.BY_EXT[".ts"]
    for text in (
      "const x = 1; /* dangling\nexport function f() {}\nconst y = 2;\n",
      "/* a */ /* b\nexport function g() {}\nconst z = 3;\n",
    ):
      found = [line for _, line in comment_scan.comment_lines(text, spec)]
      self.assertFalse(any(line.startswith("export function")
                       for line in found))
      self.assertFalse(any(line.startswith("const ") for line in found))

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

  def test_edit_reports_the_added_copy_not_its_twin(self):
    file_text = "# dup\nx = 1\ny = 2\n# dup\nz = 3\n"
    out = on_disk("Edit", "a.py", file_text,
                  old_string="y = 2\n", new_string="y = 2\n# dup\n")
    self.assertEqual(
      len([l for l in out["reason"].splitlines() if l.startswith("  ")]), 1)
    self.assertEqual(comment_scan.added(file_text, "y = 2\n", "y = 2\n# dup\n",
                                        comment_scan.BY_EXT[".py"]), [(4, "# dup")])

  def test_edit_reports_comment_duplicated_out_of_its_anchor(self):
    file_text = "# keep\nx = 1\n# keep\n"
    out = on_disk("Edit", "a.py", file_text,
                  old_string="# keep\nx = 1\n",
                  new_string="# keep\nx = 1\n# keep\n")
    self.assertIsNotNone(out, "an added comment passed the guard in silence")
    self.assertEqual(
      len([l for l in out["reason"].splitlines() if l.startswith("  ")]), 1)

  def test_write_reports_only_the_comments_it_introduces(self):
    repo = os.path.join(tempfile.mkdtemp(), "repo")
    os.makedirs(repo)
    subprocess.run(GIT + ["init", "-q"], cwd=repo, check=True)
    path = os.path.join(repo, "a.py")
    put(path, "# keep\nx = 1\n")
    subprocess.run(GIT + ["add", "a.py"], cwd=repo, check=True)
    subprocess.run(GIT + ["commit", "-q", "-m", "init"], cwd=repo, check=True)

    grown = "# keep\nx = 1\n# added\ny = 2\n"
    put(path, grown)
    out = hook("no_comments.py", write("Write", path, content=grown))
    self.assertEqual([l.strip() for l in out["reason"].splitlines()
                      if l.startswith("  ")], ["a.py: # added"])

    rewritten = "# keep\ny = 2\n"
    put(path, rewritten)
    self.assertIsNone(
      hook("no_comments.py", write("Write", path, content=rewritten)))

  def test_multiedit_reports_the_comments_it_introduces(self):
    repo = os.path.join(tempfile.mkdtemp(), "repo")
    os.makedirs(repo)
    subprocess.run(GIT + ["init", "-q"], cwd=repo, check=True)
    path = os.path.join(repo, "a.py")
    put(path, "# kept\nx = 1\n")
    subprocess.run(GIT + ["add", "a.py"], cwd=repo, check=True)
    subprocess.run(GIT + ["commit", "-q", "-m", "init"], cwd=repo, check=True)

    grown = "# kept\nx = 1\n# added\ny = 2\n"
    put(path, grown)
    out = hook("no_comments.py", write("MultiEdit", path, content=grown))
    self.assertEqual([l.strip() for l in out["reason"].splitlines()
                      if l.startswith("  ")], ["a.py: # added"])

  def test_notebook_edit_is_refused_by_both_hooks(self):
    payload = {"hook_event_name": "PostToolUse", "tool_name": "NotebookEdit",
               "tool_input": {"notebook_path": "/repo/a.ipynb"}}
    for script in ("no_comments.py", "no_em_dash.py"):
      out = hook(script, payload)
      self.assertIsNotNone(
        out, f"{script} passed NotebookEdit in silence")
      self.assertIn("NotebookEdit", out["reason"])

  def test_an_uncovered_tool_bearing_a_path_is_scanned_not_refused(self):
    d = tempfile.mkdtemp()
    path = os.path.join(d, "a.py")
    put(path, "# narration\nx = 1\n")
    out = hook("no_comments.py", write("EditNotebookCell", path))
    self.assertIsNotNone(out)
    self.assertIn("# narration", out["reason"])
    self.assertNotIn("unguarded", out["reason"])

  def test_an_uncovered_tool_without_a_path_is_refused(self):
    payload = {"hook_event_name": "PostToolUse", "tool_name": "SomeFutureEdit",
               "tool_input": {"target": "/repo/a.py"}}
    for script in ("no_comments.py", "no_em_dash.py"):
      out = hook(script, payload)
      self.assertIsNotNone(out, f"{script} passed an unknown tool in silence")
      self.assertIn("SomeFutureEdit", out["reason"])

  def test_matcher_covers_only_the_guarded_tools(self):
    with open(os.path.join(HERE, "tools.py")) as f:
      tree = ast.parse(f.read())
    matcher = next(node.value.value for node in tree.body
                   if isinstance(node, ast.Assign) and node.targets[0].id == "MATCHER")
    pattern = re.compile(matcher)
    self.assertIsNone(pattern.search("NotebookEdit"))
    for tool in ("Edit", "MultiEdit", "Write"):
      self.assertIsNotNone(pattern.search(tool))

  def test_reindenting_a_comment_is_not_an_addition(self):
    self.assertIsNone(on_disk("Edit", "a.py", "    # kept\nx = 1\n",
                              old_string="  # kept", new_string="    # kept"))

  def test_write_reports_a_line_its_edit_exposed_as_a_comment(self):
    repo = os.path.join(tempfile.mkdtemp(), "repo")
    os.makedirs(repo)
    subprocess.run(GIT + ["init", "-q"], cwd=repo, check=True)
    path = os.path.join(repo, "a.py")
    put(path, '"""\n# newly exposed comment\n"""\nx = 1\n')
    subprocess.run(GIT + ["add", "a.py"], cwd=repo, check=True)
    subprocess.run(GIT + ["commit", "-q", "-m", "init"], cwd=repo, check=True)

    exposed = "# newly exposed comment\nx = 1\n"
    put(path, exposed)
    out = hook("no_comments.py", write("Write", path, content=exposed))
    self.assertIsNotNone(out, "a line the write turned into a comment passed")
    self.assertIn("newly exposed", out["reason"])

  def test_replacement_text_inside_an_untouched_comment_is_not_added(self):
    self.assertIsNone(on_disk("Edit", "a.py", "# answer = 2\nanswer = 2\n",
                              old_string="answer = 1", new_string="answer = 2"))
    self.assertIsNone(on_disk("Edit", "a.py", "x = 2\n# version 2\n",
                              old_string="1", new_string="2"))

  def test_code_edit_inside_a_block_comment_reports_nothing(self):
    self.assertIsNone(on_disk("Edit", "a.ts", "/*\n * kept\n */\nx=2;\n",
                              old_string=" * kept\n */\nx=1;",
                              new_string=" * kept\n */\nx=2;"))

  def test_blank_line_before_an_untouched_comment_is_not_an_addition(self):
    self.assertIsNone(on_disk("Edit", "a.py", "x = 2\n\n# keep\n",
                              old_string="x = 1\n", new_string="x = 2\n\n"))

  def test_large_repetitive_write_stays_fast(self):
    spec = comment_scan.BY_EXT[".py"]
    middle = "do_it()\n" * 8000
    body = "# one comment\n" + middle
    ends = "a = 0\n# one comment\n" + middle + "z = 0\n"
    both = "a = 1\n# one comment\n" + middle + "z = 1\n"

    started = time.monotonic()
    self.assertEqual(comment_scan.added(
      body + "do_it()\n", body, body + "do_it()\n", spec), [])
    self.assertEqual(comment_scan.added(both, ends, both, spec), [])
    self.assertLess(time.monotonic() - started, 2.0)

    sneaked = "a = 1\n# sneaked in\n" + middle + "z = 1\n"
    self.assertEqual(comment_scan.added(sneaked, "a = 0\n" + middle + "z = 0\n",
                                        sneaked, spec), [(2, "# sneaked in")])
    self.assertEqual(comment_scan.added(body + "# d\n", body, body + "# d\n", spec),
                     [(8002, "# d")])

  def test_insertion_beside_an_untouched_comment_in_a_big_file(self):
    spec = comment_scan.BY_EXT[".py"]
    middle = "do_it()\n" * 1500
    before = "a = 0\n" + middle + "# kept\nz = 0\n"
    after = "a = 1\n" + middle + "inserted()\n# kept\nz = 1\n"
    self.assertEqual(comment_scan.added(after, before, after, spec), [])

  def test_whole_file_reorder_of_distinct_lines_stays_fast(self):
    spec = comment_scan.BY_EXT[".py"]
    lines = [f"line{i}()" for i in range(16000)]
    swapped = list(lines)
    for i in range(0, len(swapped) - 1, 2):
      swapped[i], swapped[i + 1] = swapped[i + 1], swapped[i]
    before = "# c\n" + "\n".join(lines) + "\n"
    after = "# c\n" + "\n".join(swapped) + "\n"

    started = time.monotonic()
    self.assertEqual(comment_scan.added(after, before, after, spec), [])
    self.assertLess(time.monotonic() - started, 2.0)

  def test_edit_that_unbalances_a_fence_reports_what_it_exposed(self):
    out = on_disk("Edit", "a.ts", "const t = [\n// example\n`;\n",
                  old_string="const t = `", new_string="const t = [")
    self.assertIsNotNone(out, "a line the edit exposed passed the guard")
    self.assertIn("example", out["reason"])
    self.assertEqual(comment_scan.added("x = \"\"\n# note\n\"\"\"\n",
                                        "x = \"\"\"\n", "x = \"\"\n",
                                        comment_scan.BY_EXT[".py"]), [(2, "# note")])

  def test_replacement_adding_a_newline_does_not_shift_onto_a_comment(self):
    self.assertIsNone(on_disk("Edit", "a.py", "x = 2\n\n# keep\n",
                              old_string="x = 1", new_string="x = 2\n"))

  def test_added_case_table(self):
    py = comment_scan.BY_EXT[".py"]
    ts = comment_scan.BY_EXT[".ts"]
    big = "do_it()\n" * 1500
    q3 = chr(34) * 3
    cases = [
      ("twin elsewhere in the file", py,
       "# dup\nx = 1\ny = 2\n# dup\nz = 3\n", "y = 2\n", "y = 2\n# dup\n",
       [(4, "# dup")]),
      ("copy duplicated out of its anchor", py,
       "# keep\nx = 1\n# keep\n", "# keep\nx = 1\n", "# keep\nx = 1\n# keep\n",
       [(3, "# keep")]),
      ("write introduces one comment", py,
       "# keep\nx = 1\n# added\ny = 2\n", "# keep\nx = 1\n",
       "# keep\nx = 1\n# added\ny = 2\n", [(3, "# added")]),
      ("write reintroduces the same text", py,
       "# keep\ny = 2\n", "# keep\nx = 1\n", "# keep\ny = 2\n", []),
      ("replacement text sits in a comment", py,
       "# answer = 2\nanswer = 2\n", "answer = 1", "answer = 2", []),
      ("short replacement matches everywhere", py,
       "x = 2\n# version 2\n", "1", "2", []),
      ("code edit inside a block comment", ts,
       "/*\n * kept\n */\nx=2;\n", " * kept\n */\nx=1;", " * kept\n */\nx=2;", []),
      ("reindent only", py, "    # kept\nx = 1\n", "  # kept", "    # kept", []),
      ("reindent across the span boundary", py,
       "x = 2\n  # keep\n", "x = 1\n", "x = 2\n  ", []),
      ("blank line added before a comment", py,
       "x = 2\n\n# keep\n", "x = 1\n", "x = 2\n\n", []),
      ("replacement gains a trailing newline", py,
       "x = 2\n\n# keep\n", "x = 1", "x = 2\n", []),
      ("comment merely moved", py,
       "x = 1\ny = 2\n# keep\n", "# keep\nx = 1\ny = 2\n",
       "x = 1\ny = 2\n# keep\n", []),
      ("comment moved and duplicated", py,
       "x = 1\n# keep\ny = 2\n# keep\n", "# keep\nx = 1\ny = 2\n",
       "x = 1\n# keep\ny = 2\n# keep\n", [(4, "# keep")]),
      ("comment moved in a patch", py,
       "x = 1\ny = 2\n# keep\n", "# keep\nx = 1\ny = 2", "x = 1\ny = 2\n# keep", []),
      ("patch hunk adds a line inside a string", py,
       "# note\nx = 1\nDOC = " +
       chr(39) * 3 + "\n# note\n" + chr(39) * 3 + "\ny = 2\n",
       "DOC = " + chr(39) * 3 + "\n" + chr(39) * 3,
       "DOC = " + chr(39) * 3 + "\n# note\n" + chr(39) * 3, []),
      ("patch hunk adds a comment with a twin elsewhere", py,
       "# note\nx = 1\ny = 2\n# note\nz = 3\n",
       "y = 2\nz = 3", "y = 2\n# note\nz = 3", [(4, "# note")]),
      ("statement replaced by a comment", py,
       "# gone for now\ny = 2\n", "x = 1", "# gone for now", [(1, "# gone for now")]),
      ("pure deletion adds nothing", py, "# top\nx = 1\n", "y = 2", "", []),
      ("write exposes a string line", py,
       "# newly exposed comment\nx = 1\n",
       q3 + "\n# newly exposed comment\n" + q3 + "\nx = 1\n",
       "# newly exposed comment\nx = 1\n", [(1, "# newly exposed comment")]),
      ("exposure inside the edited span", py,
       "DOC = " + q3 + "\n" + q3 + "\n# note\nx = 1\n",
       "# note\n" + q3 + "\n", q3 + "\n# note\n", [(3, "# note")]),
      ("edit unbalances a fence, ts", ts,
       "const t = [\n// example\n`;\n", "const t = `", "const t = [",
       [(2, "// example")]),
      ("edit unbalances a fence, py", py,
       "x = " + chr(34) * 2 + "\n# note\n" + q3 + "\n", "x = " + q3 + "\n",
       "x = " + chr(34) * 2 + "\n", [(2, "# note")]),
      ("decoy copy inside a template literal", ts,
       "const doc = `\n// added\nfoo()\n`;\n// added\nfoo()\n", "x",
       "// added\nfoo()", [(5, "// added")]),
      ("unchanged comment in the fallback", py,
       "# kept\nx = 2\nZZZ\n", "# kept\nx = 1", "# kept\nx = 2", []),
      ("insertion beside an untouched comment", py,
       "a = 1\n" + big + "inserted()\n# kept\nz = 1\n",
       "a = 0\n" + big + "# kept\nz = 0\n",
       "a = 1\n" + big + "inserted()\n# kept\nz = 1\n", []),
    ]

    for name, spec, text, old, new, want in cases:
      with self.subTest(name):
        self.assertEqual(comment_scan.added(
          text, old, new, spec), want)

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

  def test_directive_and_license_exemptions_are_per_comment_unit(self):
    ts = comment_scan.BY_EXT[".ts"]
    py = comment_scan.BY_EXT[".py"]
    cases = [
      (ts, "/* eslint-disable no-console */\n// narration about the console\nconsole.log(1)\n",
       [(2, "// narration about the console")]),
      (py, "# pragmatic caching keeps the tree warm\nx = 1\n",
       [(1, "# pragmatic caching keeps the tree warm")]),
      (ts, "/* global state is shared between workers */\nconst a = 1;\n",
       [(1, "/* global state is shared between workers */")]),
      (ts, "// Copyright (c) 2026 Ryuu\n// narration right below the header\nexport const a = 1;\n",
       [(2, "// narration right below the header")]),
    ]

    for spec, text, want in cases:
      with self.subTest(text=text):
        self.assertEqual(comment_scan.comment_lines(text, spec), want)

  def test_license_block_and_directive_forms_stay_exempt(self):
    ts = ("/*\n * Copyright (c) 2026 Ryuu\n * MIT\n */\n"
          "// narration\nexport const a = 1;\n")
    self.assertEqual(comment_scan.comment_lines(ts, comment_scan.BY_EXT[".ts"]),
                     [(5, "// narration")])

    directives = [
      (".py", "# pragma: no cover\n"),
      (".py", "# region Parsing helpers\n"),
      (".py", "# endregion\n"),
      (".ts", "/* global $, jQuery */\n"),
      (".ts", "/* istanbul ignore next */\n"),
      (".ts", "// eslint-disable-next-line no-console\n"),
      (".py", "#!/usr/bin/env python3\n"),
      (".py", "# noqa: E501\n"),
      (".py", "# type: ignore\n"),
      (".ts", "/* eslint-disable\n   no-console,\n   no-alert */\n"),
    ]

    for suffix, text in directives:
      with self.subTest(text=text):
        self.assertEqual(comment_scan.comment_lines(
          text, comment_scan.BY_EXT[suffix]), [])

  def test_apache_header_body_stays_exempt(self):
    ts = ("/*\n * Copyright 2026 Ryuu\n *\n"
          " * Licensed under the Apache License, Version 2.0 (the \"License\");\n"
          " * you may not use this file except in compliance with the License.\n"
          " * You may obtain a copy of the License at\n"
          " *     http://www.apache.org/licenses/LICENSE-2.0\n"
          " * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.\n */\n"
          "// narration\nconst a = 1;\n")
    self.assertEqual(comment_scan.comment_lines(ts, comment_scan.BY_EXT[".ts"]),
                     [(10, "// narration")])

  def test_global_directive_modes_and_multiline_form(self):
    ts = comment_scan.BY_EXT[".ts"]
    for text in ["/* global window: readonly, myGlobal: writable */\nconst a = 1;\n",
                 "/* global\n   foo,\n   bar */\nconst a = 1;\n",
                 "/* global $, jQuery */\nconst a = 1;\n"]:
      with self.subTest(text=text):
        self.assertEqual(comment_scan.comment_lines(text, ts), [])

    prose = "/* global state is shared between workers */\nconst a = 1;\n"
    self.assertEqual(comment_scan.comment_lines(prose, ts),
                     [(1, "/* global state is shared between workers */")])

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

  def test_restored_rebuilds_a_pure_deletion(self):
    before = "const t = `\n// narration\n`;\nexport const x = 1;\n"
    old = "const t = `\n"
    after = before.replace(old, "", 1)
    self.assertEqual(comment_scan.restored(after, before, old), before)

  def test_added_reports_a_comment_exposed_by_a_pure_deletion(self):
    committed = "const t = `\n// narration\n`;\nexport const x = 1;\n"
    old = "const t = `\n"
    after = committed.replace(old, "", 1)
    before = comment_scan.restored(after, committed, old)
    self.assertEqual(comment_scan.added(
      after, before, after, comment_scan.BY_EXT[".ts"]), [(1, "// narration")])

  def test_pure_deletion_exposing_a_comment_blocks_in_a_git_repo(self):
    repo = os.path.join(tempfile.mkdtemp(), "repo")
    os.makedirs(repo)
    subprocess.run(GIT + ["init", "-q"], cwd=repo, check=True)
    path = os.path.join(repo, "a.ts")
    before = "const t = `\n// narration\n`;\nexport const x = 1;\n"
    put(path, before)
    subprocess.run(GIT + ["add", "a.ts"], cwd=repo, check=True)
    subprocess.run(GIT + ["commit", "-q", "-m", "init"], cwd=repo, check=True)

    old = "const t = `\n"
    put(path, before.replace(old, "", 1))
    out = hook("no_comments.py", write(
      "Edit", path, old_string=old, new_string=""))
    self.assertEqual(out["decision"], "block")
    self.assertIn("// narration", out["reason"])

  def test_pure_deletion_stays_silent_without_a_git_repo(self):
    d = tempfile.mkdtemp()
    path = os.path.join(d, "a.ts")
    old = "const t = `\n"
    put(path, "// narration\n`;\nexport const x = 1;\n")
    self.assertIsNone(hook("no_comments.py", write(
      "Edit", path, old_string=old, new_string="")))

  def test_restored_widens_the_probe_to_the_whole_context(self):
    committed = "const start = 1;\n\nconst t = `\n// narration\n`;\n"
    old = "const t = `\n"
    self.assertEqual(comment_scan.restored(
      committed.replace(old, "", 1), committed, old), committed)

  def test_restored_declines_a_one_sided_match_off_the_edge(self):
    self.assertIsNone(comment_scan.restored(
      "\n// kept\n", "run();// kept\n", "run();"))

  def test_restored_accepts_a_one_sided_match_on_the_edge(self):
    committed = "const t = `\n// narration\n`;\n"
    old = "const t = `\n"
    self.assertEqual(comment_scan.restored(
      committed.replace(old, "", 1), committed, old), committed)

  def test_restored_declines_a_file_too_big_to_diff_precisely(self):
    body = "".join(f"const v{n} = {n};\n"
                   for n in range(comment_scan.MATCH_LINE_LIMIT + 1))
    committed = "const t = `\n// narration\n`;\n" + body
    old = "const t = `\n"
    self.assertIsNone(comment_scan.restored(
      committed.replace(old, "", 1), committed, old))

  def test_pure_deletion_does_not_report_an_untouched_comment(self):
    repo = os.path.join(tempfile.mkdtemp(), "repo")
    os.makedirs(repo)
    subprocess.run(GIT + ["init", "-q"], cwd=repo, check=True)
    path = os.path.join(repo, "a.ts")
    before = "// kept narration\nconst remove = 1;\nexport const x = 1;\n"
    put(path, before)
    subprocess.run(GIT + ["add", "a.ts"], cwd=repo, check=True)
    subprocess.run(GIT + ["commit", "-q", "-m", "init"], cwd=repo, check=True)

    old = "const remove = 1;\n"
    put(path, before.replace(old, "", 1))
    self.assertIsNone(hook("no_comments.py", write(
      "Edit", path, old_string=old, new_string="")))

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

  def test_marker_inside_template_literal_does_not_open_string(self):
    ts = "const b = `//cdn.x/a`;\n// narration\n"
    out = hook("no_comments.py", write("Write", "/repo/a.ts", content=ts))
    self.assertIsNotNone(
      out, "a // inside a template literal latched the fence")
    self.assertIn("narration", out["reason"])

  def test_triple_quote_inside_quoted_string_does_not_open_docstring(self):
    py = "TRIPLE = '\"\"\"'\n# narration\n"
    out = hook("no_comments.py", write("Write", "/repo/a.py", content=py))
    self.assertIsNotNone(
      out, "a triple quote inside a quoted string latched the fence")
    self.assertIn("narration", out["reason"])

  def test_escaped_backslash_before_fence_still_closes_it(self):
    ts = "const p = `a\\\\`;\n// narration\n"
    out = hook("no_comments.py", write("Write", "/repo/a.ts", content=ts))
    self.assertIsNotNone(
      out, "an escaped backslash before the closing fence latched it")
    self.assertIn("narration", out["reason"])

  def test_escaped_fence_inside_template_does_not_close_it(self):
    ts = "const s = `\\``;\n// narration\n"
    out = hook("no_comments.py", write("Write", "/repo/a.ts", content=ts))
    self.assertIsNotNone(out, "an escaped fence was counted as a real one")
    self.assertIn("narration", out["reason"])
    ts = "const s = `a\\`\n// string content\n`;\n// real one\n"
    out = hook("no_comments.py", write("Write", "/repo/b.ts", content=ts))
    self.assertIn("real one", out["reason"])
    self.assertNotIn("string content", out["reason"])

  def test_backtick_in_substitution_string_does_not_close_template(self):
    ts = "const a = `${\"`\"}`;\n// narration\n"
    out = hook("no_comments.py", write("Write", "/repo/a.ts", content=ts))
    self.assertIsNotNone(
      out, "a backtick inside a substitution closed the template")
    self.assertIn("narration", out["reason"])

  def test_nested_multiline_substitution_still_closes(self):
    ts = "const h = `\n  ${x ? `\n  a\n  ` : \"\"}\n`;\n// real one\n"
    out = hook("no_comments.py", write("Write", "/repo/a.ts", content=ts))
    self.assertIsNotNone(
      out, "a substitution spanning lines left the fence open")
    self.assertIn("real one", out["reason"])

  def test_a_fence_that_never_closes_is_never_opened(self):
    for label, name, latch in (
      ("regex literal holding a fence", "a.ts", "const tick = /`/;"),
      ("fence inside a regex character class", "b.ts", "const re = /[`~]/g;"),
      ("division read as a regex", "c.ts", "const n = a /`/ b;"),
      ("bare fence in jsx text", "a.tsx", "<p>a ` b</p>"),
      ("fence behind an escape", "d.ts", "const esc = /\\`/;"),
      ("fence inside a quoted span", "e.ts", "const q = \"`\";"),
    ):
      text = latch + "\n// narration\nconst after = 2;\n"
      out = hook("no_comments.py", write(
        "Write", "/repo/" + name, content=text))
      self.assertIsNotNone(out, label + " latched the rest of the file")
      self.assertIn("narration", out["reason"])
      self.assertNotIn("const after", out["reason"])

  def test_paired_strays_resync_within_the_bound(self):
    bound = comment_scan.RESYNC_BOUND

    def latched(comment_line, literals):
      body = ["const a = /`/;\n"]
      for n in range(2, comment_line):
        body.append("const lit = `x`;\n" if literals and n % 50 == 0
                    else "const f%d = %d;\n" % (n, n))
      return "".join(body) + "// narration\nconst b = /`/;\n"

    for literals in (False, True):
      why = " with one-line literals in the blind span" if literals else ""
      self.assertEqual(
        [s for _, s in comment_scan.comment_lines(
          latched(bound + 2, literals), comment_scan.BY_EXT[".ts"])],
        ["// narration"], "a stray ran past the bound" + why)
      self.assertEqual(
        comment_scan.comment_lines(
          latched(bound + 1, literals), comment_scan.BY_EXT[".ts"]),
        [], "the bound is looser than it claims" + why)

  def test_license_block_exempt_as_a_whole(self):
    ts = "/*\n * Copyright (c) 2026 Ryuu\n * MIT\n */\nexport const a = 1;\n// narration\n"
    out = hook("no_comments.py", write("Write", "/repo/a.ts", content=ts))
    self.assertIn("narration", out["reason"])
    self.assertNotIn("Copyright", out["reason"])
    self.assertNotIn("*/", out["reason"])

  def test_shell_shapes_that_are_not_heredocs_stay_unarmed(self):
    for label, sh in (("arithmetic shift", "mask=$(( 1 << SHIFT ))\n# narration\n"),
                      ("here string", "cat <<< \"hello\"\n# narration\n"),
                      ("quoted angles", "echo \"a << b\"\n# narration\n"),
                      ("conflict marker", "<<<<<<< HEAD\n# narration\n"),
                      ("nested arithmetic", "x=$(((1<<2)))\n# narration\n")):
      out = hook("no_comments.py", write("Write", "/repo/a.sh", content=sh))
      self.assertIsNotNone(out, label + " armed a heredoc that never closes")
      self.assertIn("narration", out["reason"])

  def test_heredoc_forms_suppress_their_body(self):
    for label, sh in (("plain", "cat <<EOF\n# inside\nEOF\n# narration\n"),
                      ("tab stripped", "cat <<-EOF\n# inside\n\tEOF\n# narration\n"),
                      ("quoted hyphen", "cat <<'EO-F'\n# inside\nEO-F\n# narration\n"),
                      ("backslash escaped", "cat <<\\EOF\n# inside\nEOF\n# narration\n")):
      out = hook("no_comments.py", write("Write", "/repo/a.sh", content=sh))
      self.assertIsNotNone(out, label + " swallowed the rest of the file")
      self.assertIn("narration", out["reason"])
      self.assertNotIn("inside", out["reason"])

  def test_only_tab_stripping_heredocs_close_on_an_indented_delimiter(self):
    sh = "cat <<EOF\n# inside\n\tEOF\n# still inside\n"
    self.assertIsNone(hook("no_comments.py", write("Write", "/repo/a.sh", content=sh)),
                      "an indented delimiter closed a plain heredoc")

  def test_unbalanced_double_paren_does_not_hide_a_heredoc(self):
    sh = "[[ $s =~ ^((a|b)+)$ ]] && cat <<EOF\n# swallowed\nEOF\n# narration\n"
    out = hook("no_comments.py", write("Write", "/repo/a.sh", content=sh))
    self.assertIsNotNone(out, "an unbalanced (( hid a real heredoc")
    self.assertIn("narration", out["reason"])
    self.assertNotIn("swallowed", out["reason"])

  def test_carriage_returns_do_not_latch_a_heredoc(self):
    sh = "cat <<EOF\r\n# swallowed\r\nEOF\r\n# narration\r\n"
    out = hook("no_comments.py", write("Write", "/repo/a.sh", content=sh))
    self.assertIsNotNone(out, "a CRLF delimiter never closed the heredoc")
    self.assertIn("narration", out["reason"])
    self.assertNotIn("swallowed", out["reason"])

  def test_two_heredocs_on_one_line_both_suppress_their_bodies(self):
    sh = "cat <<A <<B\n# body of A\nA\n# body of B\nB\n# narration\n"
    out = hook("no_comments.py", write("Write", "/repo/a.sh", content=sh))
    self.assertIsNotNone(out, "a queued heredoc swallowed the rest of the file")
    self.assertIn("narration", out["reason"])
    self.assertNotIn("body of A", out["reason"])
    self.assertNotIn("body of B", out["reason"])

  def test_expansions_and_escapes_do_not_latch_the_scanner(self):
    for label, sh in (("brace replacement", "y=${x//<</lt}\n# narration\n"),
                      ("brace prefix strip", "y=${x#*<<}\n# narration\n"),
                      ("brace suffix strip", "y=${x%%<<*}\n# narration\n"),
                      ("backtick substitution",
                       "x=`cat <<EOF`\n# swallowed\nEOF\n# narration\n"),
                      ("continuation after the delimiter",
                       "cat <<EOF\\\n  | wc -l\n# swallowed\nEOF\n# narration\n"),
                      ("delimiter with a trailing space",
                       "cat <<'EOF '\n# swallowed\nEOF \n# narration\n")):
      out = hook("no_comments.py", write("Write", "/repo/a.sh", content=sh))
      self.assertIsNotNone(out, label + " blinded the rest of the file")
      self.assertIn("narration", out["reason"])
      self.assertNotIn("swallowed", out["reason"])

  def test_heredocs_behind_parens_and_quotes_keep_their_body(self):
    for label, sh in (("quoted command substitution",
                       'x="$(cat <<EOF | tr "a" "b"\n# swallowed\nEOF\n)"\n# narration\n'),
                      ("substitution closing after the operator",
                       "[[ $s =~ ^((a|b)+)$ ]] && cat <<EOF > $(dirname $(pwd))\n"
                       "# swallowed\nEOF\n# narration\n"),
                      ("escaped space before a hash",
                       "echo a\\ #b <<EOF\n# swallowed\nEOF\n# narration\n")):
      out = hook("no_comments.py", write("Write", "/repo/a.sh", content=sh))
      self.assertIsNotNone(out, label + " hid a real heredoc")
      self.assertIn("narration", out["reason"])
      self.assertNotIn("swallowed", out["reason"])

  def test_kill_switch(self):
    self.assertIsNone(hook("no_comments.py", write("Write", "/repo/a.ts", content="// x\n"),
                      env={"AGENT_HOOKS": "0"}))


class SpecSelection(unittest.TestCase):
  def test_a_fresh_spec_equal_to_shell_gets_heredoc_handling(self):
    comment_scan.BY_EXT[".bats"] = comment_scan.Spec(("#",), (), ())
    self.addCleanup(comment_scan.BY_EXT.pop, ".bats")
    spec = comment_scan.spec_for("/repo/a.bats")
    self.assertIsNot(spec, comment_scan.SHELL)
    found = [s for _, s in comment_scan.comment_lines(
      "cat <<EOF\n# inside\nEOF\n# narration\n", spec)]
    self.assertEqual(found, ["# narration"])


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

  def test_apply_patch_string_line_is_not_a_comment(self):
    d = tempfile.mkdtemp()
    put(os.path.join(d, "a.py"),
        "# note\nx = 1\nDOC = " + chr(39) * 3 + "\n# note\n" + chr(39) * 3 + "\ny = 2\n")
    body = ("*** Update File: " + os.path.join(d, "a.py") + "\n@@\n DOC = " +
            chr(39) * 3 + "\n+# note\n " + chr(39) * 3 + "\n")
    self.assertIsNone(hook("no_comments.py", self.patch(body, d)))

  def test_apply_patch_comment_with_a_twin_reports_one_line(self):
    d = tempfile.mkdtemp()
    put(os.path.join(d, "a.py"), "# note\nx = 1\ny = 2\n# note\nz = 3\n")
    body = ("*** Update File: " + os.path.join(d, "a.py") +
            "\n@@\n y = 2\n+# note\n z = 3\n")
    out = hook("no_comments.py", self.patch(body, d))
    self.assertTrue(out["reason"].startswith("1 comment line added"))

  def test_apply_patch_empty_context_line_anchors_the_right_copy(self):
    text = ("class A:\n  def run(self):\n\n    # retry once\n    go()\n\n"
            "class B:\n  def run(self):\n    # retry once\n    go()\n")
    body = ("*** Update File: /repo/a.py\n@@\n   def run(self):\n\n"
            "+    # retry once\n     go()\n")
    hunk = apply_patch.files(
      "*** Begin Patch\n" + body + "*** End Patch")[0]["hunks"][0]
    self.assertEqual(
      hunk["new"], "  def run(self):\n\n    # retry once\n    go()")
    self.assertEqual(comment_scan.added(
      text, hunk["old"], hunk["new"], comment_scan.BY_EXT[".py"]),
      [(4, "# retry once")])

  def test_apply_patch_unreadable_file_keeps_both_hunks(self):
    d = tempfile.mkdtemp()
    body = ("*** Update File: " + os.path.join(d, "gone.py") +
            "\n@@\n x = 1\n+# one\n@@\n y = 2\n+# two\n")
    out = hook("no_comments.py", self.patch(body, d))
    self.assertIn("# one", out["reason"])
    self.assertIn("# two", out["reason"])

  def test_apply_patch_delete_only_hunk_reports_exposed_comment(self):
    d = tempfile.mkdtemp()
    put(os.path.join(d, "a.py"), "# exposed\nx = 1\n")
    body = ("*** Update File: " + os.path.join(d, "a.py") + "\n@@\n-" +
            chr(39) * 3 + "\n # exposed\n-" + chr(39) * 3 + "\n x = 1\n")
    out = hook("no_comments.py", self.patch(body, d))
    self.assertIn("# exposed", out["reason"])

  def test_apply_patch_with_split_additions_reports_the_comment(self):
    d = tempfile.mkdtemp()
    path = os.path.join(d, "a.py")
    put(path, "# fresh\na = 0\ns = \'\'\'\n# fresh\ny = 2\n\'\'\'\ny = 2\n")
    body = ("*** Update File: " + path + "\n@@\n+# fresh\n a = 0\n"
            "@@\n-x = 1\n+y = 2\n")
    out = hook("no_comments.py", self.patch(body, d))
    self.assertIsNotNone(out, "split patch additions anchored on a decoy")
    self.assertIn("fresh", out["reason"])

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


class SessionBrief(unittest.TestCase):
  def setUp(self):
    self.tmp = tempfile.mkdtemp()
    self.addCleanup(shutil.rmtree, self.tmp)
    self.home = os.path.join(self.tmp, "home")
    self.plans = os.path.join(self.tmp, "plans")
    self.repo = os.path.join(self.tmp, "repo")
    for d in (self.home, self.plans, self.repo):
      os.makedirs(d)
    subprocess.run(GIT + ["init", "-q", "-b", "main"], cwd=self.repo, check=True)
    subprocess.run(GIT + ["commit", "-q", "--allow-empty",
                   "-m", "init"], cwd=self.repo, check=True)

  def fixture(self, with_mode_script=True):
    root = os.path.join(self.tmp, "fixture")
    os.makedirs(os.path.join(root, "hooks"))
    brief = os.path.join(root, "hooks", "session-brief.sh")
    shutil.copy(os.path.join(HERE, "session-brief.sh"), brief)
    if with_mode_script:
      scripts = os.path.join(root, "skills", "playbook", "scripts")
      os.makedirs(scripts)
      shutil.copy(os.path.join(HERE, "..", "skills", "playbook", "scripts",
                               "delivery-mode.sh"), scripts)
      shutil.copy(os.path.join(HERE, "..", "skills", "playbook", "scripts",
                               "extension-verdict.sh"), scripts)
      os.makedirs(os.path.join(root, "skills", "greptile"))
      put(os.path.join(root, "skills", "greptile", "SKILL.md"),
          "---\nname: greptile\ndescription: Greptile review loop.\n"
          "optional: true\nrequires: prs\n---\n")
    return brief

  def brief(self, conf=None, with_mode_script=True, cwd=None):
    env = dict(os.environ, HOME=self.home, PLANS_DIR=self.plans, AGENT_HOOKS="1")
    env.pop("SKILLS_CONF", None)
    env.pop("AGENTS_DIR", None)
    if conf is not None:
      path = os.path.join(self.tmp, "skills.conf")
      put(path, conf)
      env["SKILLS_CONF"] = path
    r = subprocess.run(["bash", self.fixture(with_mode_script)], cwd=cwd or self.repo,
                       capture_output=True, text=True, env=env)
    self.assertEqual(r.returncode, 0, r.stderr)
    context = json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"]
    delivery = [l for l in context.splitlines() if l.startswith("Delivery:")]
    self.assertEqual(len(delivery), 1, context)
    return context, delivery[0]

  def test_no_config_is_hands_off(self):
    context, line = self.brief()
    self.assertEqual(line, "Delivery: hands-off")
    self.assertEqual(context.splitlines()[1].split("  ")[0], "Branch: main")

  def test_prs_lists_active_extension(self):
    self.assertEqual(self.brief("DELIVERY=prs\nWITH=greptile\n")[1],
                     "Delivery: prs, with greptile")

  def test_hands_off_names_dropped_extension(self):
    self.assertEqual(self.brief("DELIVERY=hands-off\nWITH=greptile\n")[1],
                     "Delivery: hands-off (greptile dropped: requires DELIVERY=prs)")

  def test_notes_join_in_order(self):
    self.assertEqual(self.brief("DELIVERY=hands-off\nWITH=greptile missing\n")[1],
                     "Delivery: hands-off (greptile dropped: requires DELIVERY=prs; "
                     "missing dropped: not installed)")

  def test_missing_mode_script_is_hands_off(self):
    line = self.brief("DELIVERY=prs\n", with_mode_script=False)[1]
    self.assertEqual(line, "Delivery: hands-off")

  def test_outside_git_is_only_the_delivery_line(self):
    outside = os.path.join(self.tmp, "outside")
    os.makedirs(outside)
    context, _ = self.brief(cwd=outside)
    self.assertEqual(context, "Delivery: hands-off")

  def test_review_plan_counts_as_open(self):
    project = os.path.join(self.plans, os.path.basename(self.repo))
    os.makedirs(project)
    put(os.path.join(project, "index.tsv"),
        "id\tslug\tstatus\tpri\teffort\tblocked_by\tctx\tbranch\tupdated\tnote\n"
        "001\ttodo\tTODO\tP1\tS\t-\t-\t-\t2026-09-26\t-\n"
        "002\treview\tREVIEW\tP1\tS\t-\t-\tfeat/review\t2026-09-26\t-\n"
        "003\tdone\tDONE\tP1\tS\t-\t-\t-\t2026-09-26\t-\n"
        "004\tdropped\tDROPPED\tP1\tS\t-\t-\t-\t2026-09-26\t-\n")
    context, _ = self.brief()
    self.assertIn(f"{self.plans}/{os.path.basename(self.repo)}: 2 open. "
                  "Run /plans for the frontier.", context)


if __name__ == "__main__":
  unittest.main()

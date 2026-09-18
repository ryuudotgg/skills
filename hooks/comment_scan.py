import os
import re

C = (("//",), (("/*", "*/"),), ("`",))
JSX = (("//",), (("/*", "*/"), ("{/*", "*/}")), ("`",))
HASH = (("#",), (), ('"""', "\'\'\'"))
SHELL = (("#",), (), ())
DASH = (("--",), (("/*", "*/"),), ())
HTML = ((), (("<!--", "-->"),), ())
SFC = (("//",), (("/*", "*/"), ("<!--", "-->")), ("`",))
CSS = ((), (("/*", "*/"),), ())
SCSS = (("//",), (("/*", "*/"),), ())

BY_EXT = {
    ".js": C, ".mjs": C, ".cjs": C, ".ts": C, ".mts": C, ".cts": C,
    ".jsx": JSX, ".tsx": JSX,
    ".go": C, ".rs": C, ".java": C, ".kt": C, ".swift": C, ".scala": C, ".dart": C,
    ".c": C, ".h": C, ".cpp": C, ".cc": C, ".hpp": C, ".cs": C,
    ".php": (("//", "#"), (("/*", "*/"),), ()),
    ".py": HASH, ".sh": SHELL, ".bash": SHELL, ".zsh": SHELL, ".rb": HASH,
    ".yaml": HASH, ".yml": HASH, ".toml": HASH, ".pl": HASH, ".r": HASH,
    ".ex": HASH, ".exs": HASH, ".nix": HASH, ".tf": HASH,
    ".sql": DASH, ".lua": DASH, ".hs": DASH,
    ".html": HTML, ".htm": HTML, ".xml": HTML, ".svg": HTML,
    ".vue": SFC, ".svelte": SFC, ".astro": SFC,
    ".css": CSS, ".scss": SCSS, ".less": SCSS,
}
BY_NAME = {"Dockerfile": SHELL, "Makefile": SHELL, "Justfile": SHELL}

PRAGMA = re.compile(r"""^(?:
    \#!
  | \#\s*-\*-
  | \#\s*(?:noqa|type:\s*ignore|pragma|pylint|flake8|fmt:|shellcheck|frozen_string_literal|region|endregion)
  | //\s*(?:eslint|biome-ignore|@ts-|prettier-ignore|@flow|@jsx|\#region|\#endregion|go:|nolint|\+build|@__PURE__|@vitest|@vite)
  | /\*\*?\s*(?:eslint|biome-ignore|prettier-ignore|@__PURE__|webpackChunkName|global\b|c8\b|istanbul|@type\b|@jsxImportSource)
  | \{/\*\s*(?:eslint|prettier-ignore)
  | --\s*(?:noqa|sqlfluff)
  | <!--\s*(?:prettier|@|\[if)
)""", re.X | re.I)
LICENSE = re.compile(
  r"SPDX-License-Identifier|Copyright\s*(?:\(c\)|©|\d{4})|Licensed under|All rights reserved", re.I)

DEFAULT_SKIP = ("node_modules/", "/.git/", "/dist/", "/build/", "/out/",
                "/target/", "/vendor/", "/generated/", "/.venv/",
                "/_archive/", "/done/")


def skip_path(path):
  raw = os.environ.get("AGENT_HOOKS_SKIP")
  skip = tuple(s.strip()
               for s in raw.split(",") if s.strip()) if raw else DEFAULT_SKIP
  return any(s in path for s in skip)


def spec_for(path):
  base = os.path.basename(path)
  if base in BY_NAME:
    return BY_NAME[base]
  return BY_EXT.get(os.path.splitext(base)[1].lower())


HEREDOC = re.compile(r"<<-?\s*['\"]?(\w+)['\"]?")
QUOTED = re.compile(r"'(?:\\.|[^'\\\n])*'|\"(?:\\.|[^\"\\\n])*\"")


def _code_only(raw, spec):
  code = QUOTED.sub("''", raw)
  for m in spec[0]:
    i = code.find(m)
    if i >= 0:
      code = code[:i]
  return code


def _in_string(state, raw, spec):
  markers, blocks, fences = spec
  if state.get("heredoc"):
    if raw.strip() == state["heredoc"]:
      state["heredoc"] = None
    return True
  inside = state.get("open")
  starts = tuple(markers) + tuple(opener for opener, _ in blocks)
  if inside is None and starts and raw.lstrip().startswith(starts):
    return False
  if inside is None and spec is SHELL:
    m = HEREDOC.search(raw)
    if m and "<<" in raw:
      state["heredoc"] = m.group(1)
      return False
  was_inside = inside is not None
  for fence in fences:
    haystack = raw if len(fence) > 1 else _code_only(raw, spec)
    n = haystack.count(fence) - haystack.count("\\" + fence)
    if n % 2:
      state["open"] = None if inside == fence else (
        fence if inside is None else inside)
      inside = state["open"]
  return was_inside


def comment_lines(text, spec):
  markers, blocks, _ = spec
  out = []
  closer = None
  state = {}
  for n, raw in enumerate(text.split("\n"), 1):
    s = raw.strip()
    if closer:
      out.append((n, s))
      if closer in s:
        closer = None
      continue
    if _in_string(state, raw, spec) or not s:
      continue
    for opener, close in blocks:
      if s.startswith(opener):
        out.append((n, s))
        if close not in s[len(opener):]:
          closer = close
        break
    else:
      if any(s.startswith(m) for m in markers):
        out.append((n, s))
  return _drop_pragmas_and_licenses(out)


BLOCK_OPENERS = ("/*", "{/*", "<!--")


def _drop_pragmas_and_licenses(found):
  kept = []
  run = []
  prev = None
  for n, s in found + [(None, "")]:
    if prev is not None and n == prev + 1:
      run.append((n, s))
    else:
      if run and not _exempt_run(run):
        kept.extend(run)
      run = [(n, s)]
    prev = n
  return [(n, s) for n, s in kept if not PRAGMA.match(s)]


def _exempt_run(run):
  if any(LICENSE.search(s) for _, s in run):
    return True
  first = run[0][1]
  return first.startswith(BLOCK_OPENERS) and PRAGMA.match(first) is not None


def added(file_text, old_text, new_text, spec):
  fresh = {l.strip() for l in (new_text or "").split("\n")}
  fresh -= {l.strip() for l in (old_text or "").split("\n")}
  return [(n, s) for n, s in comment_lines(file_text or "", spec) if s in fresh]


def clip(s, width=90):
  return s if len(s) <= width else s[: width - 3] + "..."


RULE = ("Default is none. Delete each. Keep one line only where it names an "
        "external constraint, a landmine, or why the obvious approach lost.")

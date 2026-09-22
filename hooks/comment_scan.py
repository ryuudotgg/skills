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


QUOTED = re.compile(r"'(?:\\.|[^'\\\n])*'|\"(?:\\.|[^\"\\\n])*\"")
METACHARS = ";&|<>()`"


def _interpolates(fence):
  return fence[0] not in "\"'"


def _past_quoted(raw, i):
  quoted = QUOTED.match(raw, i)
  return quoted.end() if quoted else i + 1


def _breaks_word(c):
  return c.isspace() or c in METACHARS


def _heredoc_word(raw, i):
  out = []
  while i < len(raw):
    c = raw[i]
    if c == "\\":
      if i + 1 >= len(raw):
        break
      out.append(raw[i + 1])
      i += 2
    elif c in "'\"":
      quoted = QUOTED.match(raw, i)
      if quoted is None:
        break
      out.append(quoted.group()[1:-1])
      i = quoted.end()
    elif _breaks_word(c):
      break
    else:
      out.append(c)
      i += 1
  return "".join(out)


def _heredoc_at(raw, i):
  strip_tabs = raw.startswith("-", i)
  if strip_tabs:
    i += 1
  while i < len(raw) and raw[i] in " \t":
    i += 1
  term = _heredoc_word(raw, i)
  return (term, strip_tabs) if term else None


def _heredocs_after(raw):
  parens = []
  braces = []
  spans = []
  operators = []
  popped = None
  escaped = -1
  i = 0
  while i < len(raw):
    c = raw[i]
    if c == "\\":
      i += 2
      escaped = i
    elif c == "'":
      i = _past_quoted(raw, i)
    elif c == '"':
      span = QUOTED.match(raw, i)
      i = span.end() if span and "$(" not in span.group() else i + 1
    elif c == "#" and i != escaped and (i == 0 or _breaks_word(raw[i - 1])):
      break
    elif raw.startswith("${", i):
      braces.append(i)
      i += 2
    elif c == "}" and braces:
      spans.append((braces.pop(), i))
      i += 1
    elif c == "(":
      parens.append(i)
      i += 1
    elif c == ")":
      if parens:
        start = parens.pop()
        if popped == (start + 1, i - 1):
          spans.append((start, i - 1))
        popped = (start, i)
      i += 1
    elif c == "<":
      end = i
      while end < len(raw) and raw[end] == "<":
        end += 1
      if end - i == 2:
        operators.append((i, end))
      i = end
    else:
      i += 1
  queued = [_heredoc_at(raw, end) for at, end in operators
            if not any(a < at < b for a, b in spans)]
  return [q for q in queued if q]


def _heredoc_closed(raw, pending):
  term, strip_tabs = pending
  return (raw.lstrip("\t") if strip_tabs else raw).rstrip("\r\n") == term


def _fence_after(raw, spec, inside):
  markers, _, fences = spec
  widest = sorted(fences, key=len, reverse=True)
  i = 0
  while i < len(raw):
    if raw[i] == "\\":
      i += 2
    elif inside is not None:
      if raw.startswith(inside, i):
        i += len(inside)
        inside = None
      elif _interpolates(inside):
        i = _past_quoted(raw, i)
      else:
        i += 1
    else:
      fence = next((f for f in widest if raw.startswith(f, i)), None)
      if fence is not None:
        inside = fence
        i += len(fence)
      elif any(raw.startswith(m, i) for m in markers):
        break
      else:
        i = _past_quoted(raw, i)
  return inside


def _in_string(state, raw, spec):
  markers, blocks, _ = spec
  queued = state.get("heredoc")
  if queued:
    if _heredoc_closed(raw, queued[0]):
      state["heredoc"] = queued[1:]
    return True
  inside = state.get("open")
  starts = tuple(markers) + tuple(opener for opener, _ in blocks)
  if inside is None and starts and raw.lstrip().startswith(starts):
    return False
  if inside is None and spec == SHELL:
    opened = _heredocs_after(raw)
    if opened:
      state["heredoc"] = opened
      return False
  state["open"] = _fence_after(raw, spec, inside)
  return inside is not None


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

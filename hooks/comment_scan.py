import difflib
import os
import re

from collections import Counter
from typing import NamedTuple


class Spec(NamedTuple):
  markers: tuple
  blocks: tuple
  fences: tuple
  exclude: tuple = ()


C = Spec(("//",), (("/*", "*/"),), ("`",))
JSX = Spec(("//",), (("/*", "*/"), ("{/*", "*/}")), ("`",))
HASH = Spec(("#",), (), ('"""', "\'\'\'"))
SHELL = Spec(("#",), (), ())
SQL = Spec(("--",), (("/*", "*/"),), ())
LUA = Spec(("--",), (("--[[", "]]"),), ())
HASKELL = Spec(("--",), (("{-", "-}"),), ())
HTML = Spec((), (("<!--", "-->"),), ())
SFC = Spec(("//",), (("/*", "*/"), ("<!--", "-->")), ("`",))
CSS = Spec((), (("/*", "*/"),), ())
SCSS = Spec(("//",), (("/*", "*/"),), ())
PHP = Spec(("//", "#"), (("/*", "*/"),), (), ("#[",))

BY_EXT = {
    ".js": C, ".mjs": C, ".cjs": C, ".ts": C, ".mts": C, ".cts": C,
    ".jsx": JSX, ".tsx": JSX,
    ".go": C, ".rs": C, ".java": C, ".kt": C, ".swift": C, ".scala": C, ".dart": C,
    ".c": C, ".h": C, ".cpp": C, ".cc": C, ".hpp": C, ".cs": C,
    ".php": PHP,
    ".py": HASH, ".sh": SHELL, ".bash": SHELL, ".zsh": SHELL, ".rb": HASH,
    ".yaml": HASH, ".yml": HASH, ".toml": HASH, ".pl": HASH, ".r": HASH,
    ".ex": HASH, ".exs": HASH, ".nix": HASH, ".tf": HASH,
    ".sql": SQL, ".lua": LUA, ".hs": HASKELL,
    ".html": HTML, ".htm": HTML, ".xml": HTML, ".svg": HTML,
    ".vue": SFC, ".svelte": SFC, ".astro": SFC,
    ".css": CSS, ".scss": SCSS, ".less": SCSS,
}
BY_NAME = {"Dockerfile": SHELL, "Makefile": SHELL, "Justfile": SHELL}

PRAGMA = re.compile(r"""^(?:
    \#!
  | \#\s*-\*-
  | \#\s*(?:noqa|type:\s*ignore|pragma(?::|\s+once\b)|pylint|flake8|fmt:|shellcheck|frozen_string_literal|(?:end)?region\b)
  | //\s*(?:eslint|biome-ignore|@ts-|prettier-ignore|@flow|@jsx|\#region|\#endregion|go:|nolint|\+build|@__PURE__|@vitest|@vite)
  | /\*\*?\s*(?:eslint|biome-ignore|prettier-ignore|@__PURE__|webpackChunkName|c8\b|istanbul\s+ignore\b|@type\b|@jsxImportSource)
  | /\*\*?\s*global\b (?: \s*(?:\*/)?\s*$
                        | \s+ [\w$]+ (?:\s*:\s*\w+)?
                          (?:\s*,\s*[\w$]+(?:\s*:\s*\w+)?)* \s*,?\s* (?:\*/)?\s*$ )
  | \{/\*\s*(?:eslint|prettier-ignore)
  | --\s*(?:noqa|sqlfluff)
  | \{-\#
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
  markers, fences = spec.markers, spec.fences
  widest = sorted(fences, key=len, reverse=True)
  closed = False
  i = 0
  while i < len(raw):
    if raw[i] == "\\":
      i += 2
    elif inside is not None:
      if raw.startswith(inside, i):
        i += len(inside)
        inside = None
        closed = True
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
  return inside, closed


RESYNC_BOUND = 256


def _last_close_line(lines, spec):
  last = {}
  for n, raw in enumerate(lines, 1):
    for fence in spec.fences:
      if fence in raw and _fence_after(raw, spec, fence)[1]:
        last[fence] = n
  return last


def _in_string(state, raw, n, spec):
  markers, blocks = spec.markers, spec.blocks
  queued = state.get("heredoc")
  if queued:
    if _heredoc_closed(raw, queued[0]):
      state["heredoc"] = queued[1:]
    return True
  inside = state.get("open")
  starts = tuple(markers) + tuple(opener for opener, _ in blocks)
  head = raw.lstrip()
  if (inside is None and starts and head.startswith(starts)
          and not head.startswith(spec.exclude)):
    return False
  if inside is None and spec == SHELL:
    opened = _heredocs_after(raw)
    if opened:
      state["heredoc"] = opened
      return False

  opened, _ = _fence_after(raw, spec, inside)
  started = n if inside is None else state["since"]
  if opened is not None and (state["last"].get(opened, 0) <= n
                             or n - started >= RESYNC_BOUND):
    opened = None

  state["open"] = opened
  state["since"] = started
  return inside is not None


def comment_lines(text, spec):
  markers, blocks = spec.markers, spec.blocks
  units = []
  closer = None
  pending = []
  lines = text.split("\n")
  state = {"last": _last_close_line(lines, spec), "since": 0}

  for n, raw in enumerate(lines, 1):
    s = raw.strip()
    if closer:
      pending.append((n, s))
      if closer in s:
        units.append(pending)
        closer = None
        pending = []
      continue
    if _in_string(state, raw, n, spec) or not s:
      continue
    if s.startswith(spec.exclude):
      continue
    for opener, close in blocks:
      if s.startswith(opener):
        if close not in s[len(opener):]:
          closer = close
          pending = [(n, s)]
        else:
          units.append([(n, s)])
        break
    else:
      if any(s.startswith(m) for m in markers):
        units.append([(n, s)])
  if pending:
    units.append([pending[0]])
  return _drop_pragmas_and_licenses(units)


def _drop_pragmas_and_licenses(units):
  return [line for unit in units if not _exempt_unit(unit) for line in unit]


def _exempt_unit(unit):
  return bool(PRAGMA.match(unit[0][1])
              or any(LICENSE.search(s) for _, s in unit))


MATCH_WORK_LIMIT = 2_000_000
MATCH_LINE_LIMIT = 2000


def _over_budget(old_mid, new_mid):
  if max(len(old_mid), len(new_mid)) > MATCH_LINE_LIMIT:
    return True

  counts = Counter(old_mid)

  return sum(counts[line] for line in new_mid) > MATCH_WORK_LIMIT


def _changed_indices(old_text, new_text):
  old_lines = [l.strip() for l in (old_text or "").split("\n")]
  new_lines = [l.strip() for l in new_text.split("\n")]

  head = 0
  while (head < len(old_lines) and head < len(new_lines)
         and old_lines[head] == new_lines[head]):
    head += 1

  tail = 0
  while (tail < len(old_lines) - head and tail < len(new_lines) - head
         and old_lines[len(old_lines) - 1 - tail] == new_lines[len(new_lines) - 1 - tail]):
    tail += 1

  old_mid = old_lines[head:len(old_lines) - tail]
  new_mid = new_lines[head:len(new_lines) - tail]

  if _over_budget(old_mid, new_mid):
    surplus = Counter(new_mid) - Counter(old_mid)

    return {j + head for j, line in enumerate(new_mid) if line in surplus}

  matcher = difflib.SequenceMatcher(None, old_mid, new_mid, autojunk=False)

  return {j + head for tag, _, _, j1, j2 in matcher.get_opcodes()
          if tag != "equal" for j in range(j1, j2)}


def _sole_offset(text, new_text):
  start = text.find(new_text)
  if start == -1 or text.find(new_text, start + 1) != -1:
    return None

  return start


def _windows(count, cap):
  widest = min(count, cap)
  sizes = []
  m = 1

  while m < widest:
    sizes.append(m)
    m *= 2

  return sizes + [widest] if widest else []


def _splice_offset(text, context, trailing, cap):
  lines = context.split("\n")

  for m in _windows(len(lines), cap):
    probe = "\n".join(lines[:m] if trailing else lines[-m:])
    offset = _sole_offset(text, probe) if probe else None
    if offset is not None:
      return offset if trailing else offset + len(probe)

  return None


def restored(text, head_text, old_text, cap=64):
  if not old_text or not head_text:
    return None

  p = _sole_offset(head_text, old_text)
  if p is None:
    return None

  lead = head_text[:p]
  tail = head_text[p + len(old_text):]
  leading = _splice_offset(text, lead, False, cap) if lead else None
  trailing = _splice_offset(text, tail, True, cap) if tail else None

  if lead and tail:
    if leading is None or trailing is None or leading != trailing:
      return None
    k = leading
  else:
    k = leading if leading is not None else trailing
    edge = 0 if not lead else len(text)
    if k is None or k != edge:
      return None

  out = text[:k] + old_text + text[k:]
  if out.count("\n") > MATCH_LINE_LIMIT:
    return None

  return out if _sole_offset(out, old_text) is not None else None


def added(file_text, old_text, new_text, spec):
  if not new_text:
    return []

  text = file_text or ""
  found = comment_lines(text, spec)
  if not found:
    return []

  old_text = old_text or ""
  start = _sole_offset(text, new_text)

  if start is None:
    surplus = (Counter(l.strip() for l in new_text.split("\n"))
               - Counter(l.strip() for l in old_text.split("\n")))

    return [(n, s) for n, s in found if surplus[s]]

  base = text.count("\n", 0, start)
  before = text[:start] + old_text + text[start + len(new_text):]
  was = comment_lines(before, spec)
  was_comment = {n for n, _ in was}

  shift = new_text.count("\n") - old_text.count("\n")
  new_end = base + new_text.count("\n") + 1
  old_end = new_end - shift

  in_span = [(n, s) for n, s in found if base < n <= new_end]
  surplus = (Counter(s for _, s in in_span)
             - Counter(s for n, s in was if base < n <= old_end))

  changed = _changed_indices(old_text, new_text)
  picked = set()

  for flagged in (True, False):
    for n, s in in_span:
      if n in picked or surplus[s] < 1:
        continue
      if (n - base - 1 in changed) is flagged:
        surplus[s] -= 1
        picked.add(n)

  out = []

  for n, s in found:
    if n <= base:
      fresh = n not in was_comment
    elif n > new_end:
      fresh = n - shift not in was_comment
    else:
      fresh = n in picked

    if fresh:
      out.append((n, s))

  return out


def clip(s, width=90):
  return s if len(s) <= width else s[: width - 3] + "..."


RULE = ("Default is none. Delete each. Keep one line only where it names an "
        "external constraint, a landmine, or why the obvious approach lost.")

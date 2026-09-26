import json
import os
import re
import shlex
import subprocess
import sys
from dataclasses import dataclass


COMMIT_SHAPE = ('git commit -m "<type>(<scope>): <summary>", one line, 50 '
                'characters or fewer, no trailer, also accepted as git -C <dir> '
                'commit -m and gh stack add -m')
COMMENT_SHAPE = 'gh pr comment <number> --body "@greptileai", only while greptile is active'
BOTH_SHAPES = f"{COMMIT_SHAPE}; {COMMENT_SHAPE}"
MESSAGE = re.compile(
  r"^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^()\s]+\))?!?: \S(.*\S)?$")
FALLBACK = re.compile(r"\bgit\b.*\bcommit|\bgh\b.*\bpr\b.*\bcomment|\bgh\b.*\bstack\b.*\badd")
PUNCTUATION = set(";|&()<>")
GIT_VALUE_OPTIONS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env",
                     "--exec-path", "--super-prefix", "--attr-source"}
NESTING = {"bash", "sh", "zsh", "dash", "ksh", "fish", "eval", "ssh", "su"}
UNSAFE = ("\n", "\r", "$", "`", "\\")


@dataclass(frozen=True)
class Result:
  kind: str
  detail: str = ""


PASS = Result("PASS")


def deny(reason):
  print(json.dumps({"hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": reason,
  }}))


def command(payload):
  tool_input = payload.get("tool_input")
  if not isinstance(tool_input, dict):
    raise ValueError

  value = tool_input.get("command")
  if isinstance(value, str):
    return value

  if not isinstance(value, list) or not all(isinstance(part, str) for part in value):
    raise ValueError

  if (len(value) == 3 and os.path.basename(value[0]) in {"bash", "sh", "zsh"} and
      value[1] in {"-c", "-lc"}):
    return value[2]

  return shlex.join(value)


def tokens(raw):
  lexer = shlex.shlex(raw.replace("`", " ; ").replace("$(", " ; "), posix=True,
                      punctuation_chars=True)
  lexer.whitespace_split = True
  lexer.commenters = ""
  return list(lexer)


def is_punctuation(part):
  return bool(part) and all(char in PUNCTUATION for char in part)


def segments(parts):
  found = [[]]
  for part in parts:
    if is_punctuation(part):
      found.append([])
    else:
      found[-1].append(part)

  return found


def git_subcommand(parts, index):
  index += 1
  while index < len(parts):
    part = parts[index]
    if part in GIT_VALUE_OPTIONS:
      index += 2
    elif part.startswith("-"):
      index += 1
    else:
      return part

  return ""


def in_order(parts, first, second):
  return first in parts and second in parts[parts.index(first) + 1:]


def has_stack_message(parts):
  return any(part.startswith("-m") or part == "--message" or
             part.startswith("--message=") or re.fullmatch(r"-[A-Za-z]*m", part)
             for part in parts)


def guarded(parts):
  commit = False
  comment = False
  for segment in segments(parts):
    for index, part in enumerate(segment):
      name = os.path.basename(part)
      if name == "git" and git_subcommand(segment, index) in {"commit", "commit-tree"}:
        commit = True

      if name != "gh":
        continue

      rest = segment[index + 1:]
      if in_order(rest, "pr", "comment"):
        comment = True

      if in_order(rest, "stack", "add") and has_stack_message(rest):
        commit = True

  return commit, comment


def message(value):
  if "\n" in value or "\r" in value:
    return "multi line message"

  if len(value) > 50:
    return "message is longer than 50 characters"

  if not MESSAGE.fullmatch(value):
    return "message has no Conventional prefix"

  return ""


def one_message(parts):
  if len(parts) == 2 and parts[0] in {"-m", "--message"}:
    return parts[1]

  if len(parts) == 1 and parts[0].startswith("-m") and len(parts[0]) > 2:
    return parts[0][2:]

  if len(parts) == 1 and parts[0].startswith("--message="):
    return parts[0][len("--message="):]

  return None


def git_commit(parts):
  rest = parts[1:]
  if len(rest) >= 2 and rest[0] == "-C":
    rest = rest[2:]

  if not rest or rest[0] != "commit":
    return None

  value = one_message(rest[1:])
  if value is not None:
    return Result("COMMIT", message(value))

  if "--amend" in rest:
    return Result("DENY_COMMIT", "amend is not allowed")

  return Result("DENY_COMMIT", "commit has an extra flag or no single message")


def stack_add(parts):
  rest = parts[3:]
  for message_parts, positional in ((rest, []), (rest[1:], rest[:1]), (rest[:-1], rest[-1:])):
    value = one_message(message_parts)
    if value is not None and not any(part.startswith("-") for part in positional):
      return Result("COMMIT", message(value))

  if has_stack_message(rest):
    return Result("DENY_COMMIT", "stack add has an extra flag or no single message")

  return None


def pr_comment(parts):
  if (len(parts) == 6 and parts[3].isdigit() and parts[4] == "--body" and
      parts[5] == "@greptileai"):
    return Result("COMMENT")

  return Result("DENY_COMMENT", "PR comment is not the Greptile shape")


def allowed(raw, parts):
  if any(char in raw for char in UNSAFE) or any(is_punctuation(part) for part in parts):
    return None

  if parts[:1] == ["git"]:
    return git_commit(parts)

  if parts[:3] == ["gh", "stack", "add"]:
    return stack_add(parts)

  if parts[:3] == ["gh", "pr", "comment"]:
    return pr_comment(parts)

  return None


def classify(raw):
  try:
    parts = tokens(raw)
  except ValueError:
    if any(FALLBACK.search(line) for line in raw.splitlines()):
      return Result("DENY", "command could not be parsed")

    return PASS

  exact = allowed(raw, parts)
  if exact is not None:
    return exact

  commit, comment = guarded(parts)
  if commit:
    return Result("DENY_COMMIT", "chained, substituted, multi line or unsupported commit")

  if comment:
    return Result("DENY_COMMENT", "chained, substituted, multi line or unsupported PR comment")

  for segment in segments(parts):
    if (any(os.path.basename(part) in NESTING for part in segment) and
        any(FALLBACK.search(part) for part in segment)):
      return Result("DENY", "nested command")

  return PASS


def mode():
  here = os.path.dirname(os.path.abspath(__file__))
  agents = os.environ.get("AGENTS_DIR", os.path.join(os.path.expanduser("~"), ".agents", "skills"))
  candidates = [
    os.path.join(here, "..", "skills", "playbook", "scripts", "delivery-mode.sh"),
    os.path.join(agents, "playbook", "scripts", "delivery-mode.sh"),
  ]

  script = next((path for path in candidates if os.path.isfile(path)), None)
  if script is None:
    return "hands-off", set()

  try:
    run = subprocess.run(["sh", script], capture_output=True, text=True, timeout=5)
  except Exception:
    return "hands-off", set()

  lines = run.stdout.splitlines()
  if run.returncode != 0 or not lines or lines[0] != "prs":
    return "hands-off", set()

  return "prs", set(lines[1:])


def decide(result):
  commit_reason = f"Allowed shape: {COMMIT_SHAPE}."
  comment_reason = f"Allowed shape: {COMMENT_SHAPE}."

  if result.kind == "PASS":
    return

  if result.kind == "DENY_COMMIT":
    deny(f"Blocked: {result.detail}. {commit_reason}")
    return

  if result.kind == "DENY_COMMENT":
    deny(f"Blocked: {result.detail}. {comment_reason}")
    return

  if result.kind == "DENY":
    deny(f"Blocked: {result.detail}. Allowed shapes: {BOTH_SHAPES}.")
    return

  delivery, extensions = mode()
  if result.kind == "COMMIT" and result.detail:
    deny(f"Blocked: {result.detail}. {commit_reason}")
  elif result.kind == "COMMIT" and delivery != "prs":
    deny("Blocked: hands-off mode leaves the work unstaged and the operator commits. "
         f"{commit_reason}")
  elif result.kind == "COMMENT" and "greptile" not in extensions:
    deny(f"Blocked: greptile is inactive. {comment_reason}")


def main():
  try:
    payload = json.load(sys.stdin)
    if not isinstance(payload, dict):
      raise ValueError

    if payload.get("tool_name") not in (None, "Bash"):
      return

    raw = command(payload)
  except Exception:
    deny("Blocked: the payload was unreadable, so commits and PR comments stay blocked. "
         f"Allowed shapes: {BOTH_SHAPES}.")
    return

  decide(classify(raw))


if __name__ == "__main__":
  main()

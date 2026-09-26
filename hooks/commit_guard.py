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
PUSH_SHAPE = ('git push [-u] [-q] origin <branch>, or git push [-u] [-q] origin '
              'refs/heads/<branch>:refs/heads/<branch>, alone, to a local branch other '
              'than the default, prs mode only; git -C <dir> push resolves against <dir>')
OTHER_PUSH_JOB = ("publish.sh pushes and opens a branch or stack layer, and fix-round.sh pushes "
                  "a fix round.")
BOTH_SHAPES = f"{COMMIT_SHAPE}; {COMMENT_SHAPE}"
MESSAGE = re.compile(
  r"^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^()\s]+\))?!?: \S(.*\S)?$")
COMMIT_FALLBACK = re.compile(r"\bgit\b.*\bcommit|\bgh\b.*\bstack\b.*\badd")
COMMENT_FALLBACK = re.compile(r"\bgh\b.*\bpr\b.*\bcomment")
PUSH_FALLBACK = re.compile(r"\bgit\b.*\b(push|send-pack)\b|\bgh\b.*\bstack\b.*\b(push|sync|submit|link)")
FALLBACK = re.compile(f"{COMMIT_FALLBACK.pattern}|{COMMENT_FALLBACK.pattern}|{PUSH_FALLBACK.pattern}")
PUNCTUATION = set(";|&()<>")
GIT_VALUE_OPTIONS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env",
                     "--exec-path", "--super-prefix", "--attr-source"}
NESTING = {"bash", "sh", "zsh", "dash", "ksh", "fish", "eval", "ssh", "su"}
UNSAFE = ("\n", "\r", "$", "`", "\\")


@dataclass(frozen=True)
class Result:
  kind: str
  detail: str = ""
  directory: str = ""


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
  joined = raw.replace("\\\r\n", "").replace("\\\n", "")
  lexer = shlex.shlex(joined.replace("`", " ; ").replace("$(", " ; "), posix=True,
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


def pushes(segment):
  for index, part in enumerate(segment):
    name = os.path.basename(part)
    if name == "git" and git_subcommand(segment, index) in {"push", "send-pack"}:
      return True

    if name in {"git-push", "git-send-pack"}:
      return True

    if name == "git":
      rest = segment[index + 1:]
      for option, value in zip(rest, rest[1:]):
        if option == "-c" and value.lower().startswith("alias."):
          return True

    if name == "gh":
      rest = segment[index + 1:]
      if any(in_order(rest, "stack", action) for action in ("push", "sync", "submit", "link")):
        return True

  return False


def push_segments(parts):
  return [segment for segment in segments(parts) if pushes(segment)]


def push_refspecs(segment):
  for index, part in enumerate(segment):
    if os.path.basename(part) != "git":
      continue

    subcommand = git_subcommand(segment, index)
    if subcommand != "push":
      continue

    start = segment.index(subcommand, index + 1) + 1
    return [part for part in segment[start:] if not part.startswith("-") and part != "origin"]

  return []


def rewrites(part):
  short_force = part.startswith("-") and not part.startswith("--") and "f" in part[1:]
  return (short_force or part in {"--force", "--force-if-includes"} or
          part.startswith(("--force-with-lease", "+")))


def deletes(part):
  return part in {"--delete", "-d", "--prune"} or part.startswith(":")


def fans_out(part):
  return part in {"--all", "--mirror"} or "*" in part


PUSH_JOBS = (
  ("force push", lambda values, refspecs, stack: any(map(rewrites, values)),
   "A typed push never rewrites a pushed commit: fix-round.sh pushes a fix round and lease "
   "rebases the owned layers above it, and lease-rebase.sh restacks owned layers onto a moved "
   "parent."),
  ("delete push", lambda values, refspecs, stack: any(map(deletes, values)),
   "A typed push never deletes a remote ref: publish.sh and fix-round.sh make every push past "
   "the allowed shape, and removing a remote branch is the operator's."),
  ("stack push", lambda values, refspecs, stack: stack or len(refspecs) > 1 or
   any(map(fans_out, values)),
   "Stack pushes and stack submission go through publish.sh."),
)


def push_detail(parts):
  groups = push_segments(parts)
  values = [part for group in groups for part in group]
  refspecs = [refspec for group in groups for refspec in push_refspecs(group)]
  stack = any("gh" in group and "stack" in group for group in groups)
  for detail, matches, job in PUSH_JOBS:
    if matches(values, refspecs, stack):
      return f"{detail}. {job}"

  return f"chained or unsupported push. {OTHER_PUSH_JOB}"


def delivery_shell(segment):
  return (len(segment) >= 2 and os.path.basename(segment[0]) in {"sh", "bash"} and
          os.path.basename(segment[1]) in {"publish.sh", "fix-round.sh", "lease-rebase.sh"})


def guarded(parts):
  commit = False
  comment = False
  push = False
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

    if pushes(segment):
      push = True

  return commit, comment, push


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


def branch(value):
  if not value or value.startswith(("-", "refs/")):
    return ""

  if any(char in value for char in "*?[:+~^`") or any(char.isspace() for char in value):
    return ""

  return value


def pushed_branch(refspec):
  if branch(refspec):
    return refspec

  left, colon, right = refspec.partition(":")
  prefix = "refs/heads/"
  if not colon or left != right or not left.startswith(prefix):
    return ""

  return branch(left[len(prefix):])


def git_push(parts):
  rest = parts[1:]
  directory = ""
  if len(rest) >= 2 and rest[0] == "-C":
    directory, rest = rest[1], rest[2:]

  if rest[:1] != ["push"]:
    return None

  flags = rest[1:-2]
  if len(set(flags)) != len(flags) or not set(flags) <= {"-u", "-q"} or rest[-2:-1] != ["origin"]:
    return None

  return Result("PUSH", rest[-1], directory) if pushed_branch(rest[-1]) else None


def allowed(raw, parts):
  if any(char in raw for char in UNSAFE) or any(is_punctuation(part) for part in parts):
    return None

  if parts[:1] == ["git"]:
    result = git_commit(parts)
    return result if result is not None else git_push(parts)

  if parts[:3] == ["gh", "stack", "add"]:
    return stack_add(parts)

  if parts[:3] == ["gh", "pr", "comment"]:
    return pr_comment(parts)

  return None


SUBSTITUTION = re.compile(r"\$\(([^()]*)\)|`([^`]*)`")
SUBSTITUTED = {
  "COMMIT": ("DENY_COMMIT", "chained, substituted, multi line or unsupported commit"),
  "DENY_COMMIT": ("DENY_COMMIT", "chained, substituted, multi line or unsupported commit"),
  "COMMENT": ("DENY_COMMENT", "chained, substituted, multi line or unsupported PR comment"),
  "DENY_COMMENT": ("DENY_COMMENT", "chained, substituted, multi line or unsupported PR comment"),
  "PUSH": ("DENY_PUSH", f"substituted push. {OTHER_PUSH_JOB}"),
  "DENY_PUSH": ("DENY_PUSH", f"substituted push. {OTHER_PUSH_JOB}"),
  "DENY": ("DENY", "substituted command"),
}


def substituted(raw):
  rest = raw
  while match := SUBSTITUTION.search(rest):
    inner = classify(match.group(1) if match.group(1) is not None else match.group(2))
    if inner.kind in SUBSTITUTED:
      return Result(*SUBSTITUTED[inner.kind])

    rest = f"{rest[:match.start()]} _ {rest[match.end():]}"

  if ("$(" in rest or "`" in rest) and FALLBACK.search(rest):
    return Result("DENY", "substitution could not be read")

  return None


def classify(raw):
  try:
    parts = tokens(raw)
  except ValueError:
    if PUSH_FALLBACK.search(raw):
      return Result("DENY_PUSH", f"push could not be parsed. {OTHER_PUSH_JOB}")

    if any(FALLBACK.search(line) for line in raw.splitlines()):
      return Result("DENY", "command could not be parsed")

    return PASS

  hidden = substituted(raw)
  if hidden is not None:
    return hidden

  exact = allowed(raw, parts)
  if exact is not None:
    return exact

  commit, comment, push = guarded(parts)
  if commit:
    return Result("DENY_COMMIT", "chained, substituted, multi line or unsupported commit")

  if comment:
    return Result("DENY_COMMENT", "chained, substituted, multi line or unsupported PR comment")

  if push:
    return Result("DENY_PUSH", push_detail(parts))

  for segment in segments(parts):
    if (any(os.path.basename(part) in NESTING for part in segment) and
        not delivery_shell(segment) and any(FALLBACK.search(part) for part in segment)):
      if any(PUSH_FALLBACK.search(part) for part in segment):
        return Result("DENY_PUSH", push_detail(parts))

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


def push_reason(reason):
  return f"{reason} Allowed typed push: {PUSH_SHAPE}."


def git(directory, *args):
  return subprocess.run(["git", "-C", directory, *args], capture_output=True, text=True,
                        timeout=5)


def push_block(result, cwd):
  directory = os.path.join(cwd, result.directory)
  target = pushed_branch(result.detail)
  prefix = "refs/remotes/origin/"
  try:
    head = git(directory, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD")
    local = git(directory, "show-ref", "--verify", "--quiet", f"refs/heads/{target}")
    remapped = git(directory, "config", "--get-all", "remote.origin.push")
  except Exception:
    return "git could not be read, so the default branch is unknown"

  default = head.stdout.strip()[len(prefix):]
  if head.returncode != 0 or not head.stdout.startswith(prefix) or not default:
    return ("origin/HEAD is unset, so the default branch is unknown. Run git remote set-head "
            "origin -a, then push again")

  if target == default:
    return f"{default} is the default branch"

  if local.returncode != 0:
    return f"{target} is not a local branch"

  if ":" not in result.detail and remapped.returncode != 1:
    return (f"remote.origin.push may send {target} elsewhere, so name the destination: git "
            f"push origin refs/heads/{target}:refs/heads/{target}")

  return ""


def decide(result, cwd):
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

  if result.kind == "DENY_PUSH":
    deny(push_reason(f"Blocked: {result.detail}."))
    return

  if result.kind == "DENY":
    deny(push_reason(f"Blocked: {result.detail}. Allowed shapes: {BOTH_SHAPES}. {OTHER_PUSH_JOB}"))
    return

  delivery, extensions = mode()
  if result.kind == "COMMIT" and result.detail:
    deny(f"Blocked: {result.detail}. {commit_reason}")
  elif result.kind == "COMMIT" and delivery != "prs":
    deny("Blocked: hands-off mode leaves the work unstaged and the operator commits. "
         f"{commit_reason}")
  elif result.kind == "COMMENT" and "greptile" not in extensions:
    deny(f"Blocked: greptile is inactive. {comment_reason}")
  elif result.kind == "PUSH" and delivery != "prs":
    deny(push_reason("Blocked: hands-off mode leaves the work unstaged and the operator pushes."))
  elif result.kind == "PUSH" and (block := push_block(result, cwd)):
    deny(push_reason(f"Blocked: {block}."))


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

  cwd = payload.get("cwd")
  decide(classify(raw), cwd if isinstance(cwd, str) else os.getcwd())


if __name__ == "__main__":
  main()

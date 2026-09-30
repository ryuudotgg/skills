from comment_scan import RULE, clip, comment_lines, skip_path, spec_for
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

if os.environ.get("AGENT_HOOKS", "1") == "0":
  sys.exit(0)

try:
  d = json.load(sys.stdin)
except Exception:
  sys.exit(0)

MAX_REWRITES = 2

OPENERS = re.compile(r"""(?:^|[.!?:]\s+|\n\s*(?:[-*]\s+)?)(
    Let\ me\ know\ if | I\ hope\ this\ helps | Hope\ (?:this|that)\ helps | Feel\ free\ to
  | Great\ question | You're\ absolutely\ right | Certainly! | Of\ course! | Happy\ to\ help
  | It\ is\ important\ to\ note | It's\ worth\ noting | To\ summarize | In\ summary
  | Let\ me\ explain | Let's\ (?:break\ this\ down|dive\ in) | Here's\ the\ thing
)""", re.X | re.M)
LABEL = re.compile(r"\*\*[^*\n]{1,60}:\*\*|\*\*[^*\n]{1,60}\*\*:")
HYPHEN_DASH = re.compile(r"(?<=[^\s-]) -{1,2} (?=[^\s-])")
TEXT_BLOCK = re.compile(r"^```text[ \t]*\r?\n(.*?)^```[ \t]*\r?$", re.M | re.S)
PR_URL = r"https?://github\.com/[^/\s]+/[^/\s]+/pull/[0-9]+"
PR_BLOCKQUOTE = re.compile(
  rf"^[^\n]*{PR_URL}[^\n]*\n(?:[ \t]*\n)*[ \t]*> ", re.M)
PATH_TOKEN = re.compile(
  r"(?:[~/].*|[^/\s]+(?:/[^/\s]+)*/[^/\s.]+(?:\.[^/\s.]+)*\.[A-Za-z0-9]+)$")
LINE_SUFFIX = re.compile(r"(?::\d+)+$|#L\d+(?:-L\d+)?$")
PLAN_ID = re.compile(
  r"\bplan\s*#?\s*\d+\b|\bplans\s*#?\s*\d+\s*(?:,|and|or)\s*#?\s*\d+\b", re.I)


def drafted_bodies(text):
  for m in TEXT_BLOCK.finditer(text):
    above = text[:m.start()].rstrip().rpartition("\n")[2]
    if re.search(PR_URL, above):
      yield m.group(1)


def reply_findings(text):
  bodies = list(drafted_bodies(text))
  s = TEXT_BLOCK.sub("", text)
  s = re.sub(r"```.*?```", "", s, flags=re.S)
  s = re.sub(r"`[^`\n]*`", "", s)
  out = []
  if PR_BLOCKQUOTE.search(s):
    out.append(
      "a drafted reply as a blockquote under a PR link. Drafts go in a ```text block, with the thread URL on the line above the fence.")

  prose = [re.sub(r"https?://\S+", "", s)]
  path = None
  plan = None
  has_backtick = False
  for body in bodies:
    clean = re.sub(r"https?://\S+", "", body)
    prose.append(clean)

    if path is None:
      for word in clean.split():
        token = word.strip(".,;:()\"'!?[]{}<>")
        if PATH_TOKEN.fullmatch(LINE_SUFFIX.sub("", token)):
          path = token
          break

    if plan is None and (m := PLAN_ID.search(clean)):
      plan = m.group(0)

    has_backtick |= "`" in body

  if path is not None:
    out.append(
      f'a path shaped token "{path}" in a drafted reply. The operator\'s chat renders it as a local file link, so cite a commit sha instead.')
  if plan is not None:
    out.append(
      f'a plan id "{plan}" in a drafted reply. Plans exist only on this machine, so say what the code does and cite a commit sha or a linked issue.')
  if has_backtick:
    out.append("a backtick in a drafted reply. Write the draft as plain text.")

  if any("\u2014" in part or "\u2013" in part or HYPHEN_DASH.search(part)
         for part in prose):
    out.append(
      "a dash used as punctuation. Use a comma, a colon, parentheses or a full stop.")
  m = next((match for part in prose if (match := OPENERS.search(part))), None)
  if m:
    out.append(f'chatbot filler "{m.group(1).strip()}". Delete the sentence.')
  m = next((match for part in prose if (match := LABEL.search(part))), None)
  if m:
    out.append(
      f'a bold label with a colon ("{m.group(0)}"). Write it as a sentence or a plain bullet.')
  return out


def run(args, cwd):
  try:
    r = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=5)
  except Exception:
    return None
  return r.stdout if r.returncode == 0 else None


def sweep_base(cwd):
  branch = (run(["git", "symbolic-ref", "--short", "-q", "HEAD"], cwd) or "").strip()
  if not branch:
    return "HEAD"

  default = (run(["git", "symbolic-ref", "--short", "-q",
                  "refs/remotes/origin/HEAD"], cwd) or "").strip()
  if default and branch == default.partition("/")[2]:
    return "HEAD"

  recorded = (run(["git", "config", "--get", f"branch.{branch}.skills-base"], cwd)
              or "").strip()

  for candidate in (recorded, default):
    base = run(["git", "merge-base", candidate, "HEAD"], cwd) if candidate else None
    if base:
      return base.strip()

  return "HEAD"


def added_lines(cwd):
  diff = ["git", "-c", "core.quotePath=false", "diff",
          "--unified=0", "--no-color", "--diff-filter=AMR"]
  out = run(diff[:4] + [sweep_base(cwd)] + diff[4:], cwd)
  if out is None:
    out = run(diff, cwd)
  files = {}
  path = None
  for line in (out or "").splitlines():
    if line.startswith("+++ b/"):
      path = os.path.join(cwd, line[6:])
      files[path] = set()
    elif line.startswith("@@") and path:
      m = re.search(r"\+(\d+)(?:,(\d+))?", line)
      start, count = int(m.group(1)), int(m.group(2) or 1)
      files[path].update(range(start, start + count))
  untracked = run(["git", "ls-files", "-z", "--others",
                  "--exclude-standard"], cwd) or ""
  for rel in untracked.split("\0"):
    if rel:
      files[os.path.join(cwd, rel)] = None
  return files


def tree_findings(cwd, seen):
  hits = []
  root = (run(["git", "rev-parse", "--show-toplevel"], cwd)
          or "").strip() if cwd else ""
  if not root:
    return hits
  for path, lines in added_lines(root).items():
    spec = spec_for(path)
    if not spec or skip_path(path) or not os.path.isfile(path):
      continue
    try:
      text = open(path, encoding="utf-8", errors="replace").read()
    except Exception:
      continue
    for n, s in comment_lines(text, spec):
      if lines is not None and n not in lines:
        continue
      key = f"{path}\t{s}"
      if key in seen:
        continue
      hits.append((key, f"{os.path.relpath(path, root)}:{n}  {clip(s)}"))
  return hits


def state_path(d):
  base = d.get("scratchpad_dir") or "/tmp"
  return os.path.join(base, f"reply-guard-{d.get('session_id', 'anon')}.json")


sp = state_path(d)
try:
  state = json.load(open(sp))
  if isinstance(state, list):
    state = {"seen": state}
  seen = {str(key) for key in state.get("seen", [])}
  rewrites = int(state.get("rewrites", 0))
except Exception:
  seen, rewrites = set(), 0
if not d.get("stop_hook_active"):
  rewrites = 0
if rewrites >= MAX_REWRITES:
  sys.exit(0)

reply = reply_findings(d.get("last_assistant_message") or "")
tree = tree_findings(d.get("cwd") or "", seen)
shown_tree = tree[:8]
seen.update(key for key, _ in shown_tree)
rewrites = rewrites + 1 if reply or tree else 0

try:
  os.makedirs(os.path.dirname(sp), exist_ok=True)
  with open(sp, "w") as f:
    json.dump({"seen": sorted(seen), "rewrites": rewrites}, f)
except Exception:
  if d.get("stop_hook_active"):
    sys.exit(0)

if not reply and not tree:
  sys.exit(0)

parts = []
if reply:
  parts.append("Your reply has " + " It also has ".join(reply) +
               " Rewrite the reply.")
if tree:
  shown = "\n".join("  " + h for _, h in shown_tree)
  more = f"\n  ... and {len(tree) - 8} more" if len(tree) > 8 else ""
  parts.append(f"Comment lines added in this tree:\n{shown}{more}\n{RULE}")
print(json.dumps({"decision": "block", "reason": "\n".join(parts)}))

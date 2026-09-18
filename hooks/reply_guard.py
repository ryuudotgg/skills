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
if d.get("stop_hook_active"):
  sys.exit(0)

OPENERS = re.compile(r"""(?:^|[.!?:]\s+|\n\s*(?:[-*]\s+)?)(
    Let\ me\ know\ if | I\ hope\ this\ helps | Hope\ (?:this|that)\ helps | Feel\ free\ to
  | Great\ question | You're\ absolutely\ right | Certainly! | Of\ course! | Happy\ to\ help
  | It\ is\ important\ to\ note | It's\ worth\ noting | To\ summarize | In\ summary
  | Let\ me\ explain | Let's\ (?:break\ this\ down|dive\ in) | Here's\ the\ thing
)""", re.X | re.M)
LABEL = re.compile(r"\*\*[^*\n]{1,60}:\*\*|\*\*[^*\n]{1,60}\*\*:")
HYPHEN_DASH = re.compile(r"(?<=[^\s-]) -{1,2} (?=[^\s-])")


def reply_findings(text):
  s = re.sub(r"```.*?```", "", text, flags=re.S)
  s = re.sub(r"`[^`\n]*`", "", s)
  s = re.sub(r"https?://\S+", "", s)
  out = []
  if "\u2014" in s or "\u2013" in s or HYPHEN_DASH.search(s):
    out.append(
      "a dash used as punctuation. Use a comma, a colon, parentheses or a full stop.")
  m = OPENERS.search(s)
  if m:
    out.append(f'chatbot filler "{m.group(1).strip()}". Delete the sentence.')
  m = LABEL.search(s)
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


def added_lines(cwd):
  diff = ["git", "-c", "core.quotePath=false", "diff",
          "--unified=0", "--no-color", "--diff-filter=AMR"]
  out = run(diff[:4] + ["HEAD"] + diff[4:], cwd)
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
  seen = set(json.load(open(sp)))
except Exception:
  seen = set()

reply = reply_findings(d.get("last_assistant_message") or "")
tree = tree_findings(d.get("cwd") or "", seen)
shown_tree = tree[:8]
seen.update(key for key, _ in shown_tree)

try:
  os.makedirs(os.path.dirname(sp), exist_ok=True)
  json.dump(sorted(seen), open(sp, "w"))
except Exception:
  pass

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

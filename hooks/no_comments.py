from comment_scan import RULE, added, clip, skip_path, spec_for
from apply_patch import files as patch_files
from tools import WRITE_LIKE, unguarded
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

if os.environ.get("AGENT_HOOKS", "1") == "0":
  sys.exit(0)

try:
  d = json.load(sys.stdin)
except Exception:
  sys.exit(0)

ti = d.get("tool_input") or {}
tool = d.get("tool_name")


def _head_text(path):
  try:
    r = subprocess.run(
      ["git", "show", "HEAD:./" + os.path.basename(path)],
      cwd=os.path.dirname(os.path.abspath(path)),
      env={k: v for k, v in os.environ.items()
           if k not in ("GIT_DIR", "GIT_WORK_TREE")},
      capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=5)

    return r.stdout if r.returncode == 0 else ""
  except Exception:
    return ""


if tool == "apply_patch":
  edits = [(f["path"], h["old"], h["new"], "patch")
           for f in patch_files(ti.get("command"), d.get("cwd") or "")
           for h in f["hunks"]]
elif tool == "Edit":
  edits = [(ti.get("file_path") or "", ti.get(
    "old_string") or "", ti.get("new_string") or "", "edit")]
elif tool in WRITE_LIKE or ti.get("file_path"):
  edits = [(ti.get("file_path") or "", None, ti.get("content") or "", "write")]
else:
  print(json.dumps({"decision": "block", "reason": unguarded(tool)}))
  sys.exit(0)


def scan(path, old, new, mode):
  spec = spec_for(path)
  if not path or not spec or skip_path(path):
    return []

  try:
    text, scope = open(path, encoding="utf-8", errors="replace").read(), ""
  except Exception:
    text, scope = new, new

  if mode == "write":
    old, new = _head_text(path), text

  return [(scope, n, s) for n, s in added(text, old, new, spec)]


seen = {}
for path, old, new, mode in edits:
  for scope, n, s in scan(path, old, new, mode):
    seen.setdefault((path, scope, n), s)

hits = [(os.path.basename(p), s) for (p, _, _), s in sorted(seen.items())]
if not hits:
  sys.exit(0)

shown = "\n".join(f"  {name}: {clip(s)}" for name, s in hits[:6])
more = f"\n  ... and {len(hits) - 6} more" if len(hits) > 6 else ""
n = len(hits)
msg = f"{n} comment line{'s' if n > 1 else ''} added:\n{shown}{more}\n{RULE}"
print(json.dumps({"decision": "block", "reason": msg}))

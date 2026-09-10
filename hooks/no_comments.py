import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from apply_patch import files as patch_files
from comment_scan import RULE, added, clip, skip_path, spec_for

if os.environ.get("AGENT_HOOKS", "1") == "0":
    sys.exit(0)

try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)

ti = d.get("tool_input") or {}
tool = d.get("tool_name")

if tool == "apply_patch":
    edits = [(f["path"], "\n".join(f["removed"]), "\n".join(f["added"]))
             for f in patch_files(ti.get("command"), d.get("cwd") or "")]
elif tool == "Edit":
    edits = [(ti.get("file_path") or "", ti.get("old_string") or "", ti.get("new_string") or "")]
else:
    edits = [(ti.get("file_path") or "", "", ti.get("content") or "")]


def scan(path, old, new):
    spec = spec_for(path)
    if not path or not spec or skip_path(path):
        return []
    try:
        text = open(path, encoding="utf-8", errors="replace").read()
    except Exception:
        text = new
    return [(os.path.basename(path), s) for _, s in added(text, old, new, spec)]


hits = [h for path, old, new in edits for h in scan(path, old, new)]
if not hits:
    sys.exit(0)

shown = "\n".join(f"  {name}: {clip(s)}" for name, s in hits[:6])
more = f"\n  ... and {len(hits) - 6} more" if len(hits) > 6 else ""
n = len(hits)
msg = f"{n} comment line{'s' if n > 1 else ''} added:\n{shown}{more}\n{RULE}"
print(json.dumps({"decision": "block", "reason": msg}))

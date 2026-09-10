import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from comment_scan import RULE, added, clip, skip_path, spec_for

if os.environ.get("AGENT_HOOKS", "1") == "0":
    sys.exit(0)

try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)

ti = d.get("tool_input") or {}
p = ti.get("file_path") or ""
spec = spec_for(p)
if not p or not spec or skip_path(p):
    sys.exit(0)

if d.get("tool_name") == "Edit":
    old, new = ti.get("old_string") or "", ti.get("new_string") or ""
else:
    old, new = "", ti.get("content") or ""
try:
    text = open(p, encoding="utf-8", errors="replace").read()
except Exception:
    text = new

hits = added(text, old, new, spec)
if not hits:
    sys.exit(0)

shown = "\n".join("  " + clip(s) for _, s in hits[:6])
more = f"\n  ... and {len(hits) - 6} more" if len(hits) > 6 else ""
n = len(hits)
msg = (f"{os.path.basename(p)}: {n} comment line{'s' if n > 1 else ''} added:\n"
       f"{shown}{more}\n{RULE}")
print(json.dumps({"decision": "block", "reason": msg}))

import json, re, sys, os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from apply_patch import files as patch_files

if os.environ.get("AGENT_HOOKS", "1") == "0":
    sys.exit(0)

try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)

ti = d.get("tool_input") or {}
if d.get("tool_name") == "apply_patch":
    paths = [f["path"] for f in patch_files(ti.get("command"), d.get("cwd") or "")]
else:
    paths = [ti.get("file_path") or ""]

DEFAULT_SKIP = ("node_modules/", "/.git/", "/dist/", "/build/", "/out/",
                "/target/", "/vendor/", "/generated/", "/.venv/",
                "/_archive/", "/done/")
raw = os.environ.get("AGENT_HOOKS_SKIP")
skip = tuple(s.strip() for s in raw.split(",") if s.strip()) if raw else DEFAULT_SKIP
EXTS = (".md", ".ts", ".tsx", ".js", ".jsx", ".css", ".json", ".sh", ".py", ".html")


def blank(m):
    return "\n" * m.group(0).count("\n")


def check(p):
    if not p or not os.path.isfile(p) or any(s in p for s in skip) or not p.endswith(EXTS):
        return None
    try:
        t = open(p, encoding="utf-8", errors="replace").read()
    except Exception:
        return None
    s = re.sub(r"```.*?```", blank, t, flags=re.S)
    s = re.sub(r"`[^`\n]*`", "", s)
    s = re.sub(r"https?://\S+", "", s)
    names = []
    if "\u2014" in s: names.append("an em dash (U+2014)")
    if "\u2013" in s: names.append("an en dash (U+2013)")
    if not names:
        return None
    lines = [str(i + 1) for i, L in enumerate(s.splitlines())
             if "\u2014" in L or "\u2013" in L][:5]
    return (os.path.basename(p) + " contains " + " and ".join(names) +
            " (line" + ("s" if len(lines) > 1 else "") + " " + ", ".join(lines) + ").")


found = [m for m in (check(p) for p in paths) if m]
if not found:
    sys.exit(0)
msg = (" ".join(found) + " No em dashes, en dashes or hyphen as dash in anything you write. "
       "Rewrite with a comma, colon, parenthesis or full stop, then continue.")
print(json.dumps({"decision": "block", "reason": msg}))

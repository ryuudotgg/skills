import json, re, sys, os

if os.environ.get("AGENT_HOOKS", "1") == "0":
    sys.exit(0)

try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)

p = (d.get("tool_input") or {}).get("file_path") or ""
if not p or not os.path.isfile(p):
    sys.exit(0)

DEFAULT_SKIP = ("node_modules/", "/.git/", "/dist/", "/build/", "/out/",
                "/target/", "/vendor/", "/generated/", "/.venv/",
                "/_archive/", "/done/")
raw = os.environ.get("AGENT_HOOKS_SKIP")
skip = tuple(s.strip() for s in raw.split(",") if s.strip()) if raw else DEFAULT_SKIP
if any(s in p for s in skip):
    sys.exit(0)
if not p.endswith((".md", ".ts", ".tsx", ".js", ".jsx", ".css", ".json",
                   ".sh", ".py", ".html")):
    sys.exit(0)

try:
    t = open(p, encoding="utf-8", errors="replace").read()
except Exception:
    sys.exit(0)

def blank(m):
    return "\n" * m.group(0).count("\n")

s = re.sub(r"```.*?```", blank, t, flags=re.S)
s = re.sub(r"`[^`\n]*`", "", s)
s = re.sub(r"https?://\S+", "", s)

names = []
if "—" in s: names.append("an em dash (U+2014)")
if "–" in s: names.append("an en dash (U+2013)")
if not names:
    sys.exit(0)

lines = [str(i + 1) for i, L in enumerate(s.splitlines())
         if "—" in L or "–" in L][:5]
msg = (os.path.basename(p) + " contains " + " and ".join(names) +
       " (line" + ("s" if len(lines) > 1 else "") + " " + ", ".join(lines) + "). "
       "No em dashes, en dashes or hyphen as dash in anything you write. "
       "Rewrite with a comma, colon, parenthesis or full stop, then continue.")
print(json.dumps({"decision": "block", "reason": msg}))

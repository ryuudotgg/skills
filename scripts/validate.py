#!/usr/bin/env python3
import os
import re
import shlex
import shutil
import subprocess
import sys

ROOT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.dirname(
  os.path.dirname(os.path.abspath(__file__)))
SKIP_DIRS = {"node_modules", ".git"}
BUILTIN_AGENTS = {"general-purpose", "Explore", "Plan", "claude"}
errors = []


def err(path, line, msg):
  rel = os.path.relpath(path, ROOT)
  errors.append(f"{rel}:{line}: {msg}" if line else f"{rel}: {msg}")


def md_files():
  for base in ("skills", "agents", "hooks"):
    for dirpath, dirnames, filenames in os.walk(os.path.join(ROOT, base)):
      dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
      for f in filenames:
        if f.endswith(".md"):
          yield os.path.join(dirpath, f)
  readme = os.path.join(ROOT, "README.md")
  if os.path.isfile(readme):
    yield readme


def parse_frontmatter(path, text):
  if not text.startswith("---\n"):
    err(path, 1, "no frontmatter")
    return None
  end = text.find("\n---", 4)
  if end < 0:
    err(path, 1, "frontmatter never closes")
    return None
  block = text[4:end]
  try:
    import yaml
    data = yaml.safe_load(block)
    if not isinstance(data, dict):
      err(path, 1, "frontmatter is not a mapping")
      return None
    return data
  except ImportError:
    pass
  except Exception as e:
    err(path, 1, f"frontmatter does not parse: {str(e).splitlines()[0]}")
    return None
  data = {}
  for n, line in enumerate(block.splitlines(), 2):
    if not line.strip() or line.startswith(" "):
      continue
    key, sep, value = line.partition(":")
    if not sep:
      err(path, n, "frontmatter line is not key: value")
      continue
    value = value.strip()
    if value and value[0] not in "\"'" and ": " in value:
      err(path, n, "unquoted value contains ': ', which YAML rejects; quote it")
    data[key.strip()] = value.strip("\"'")
  return data


def check_frontmatter(path, expected_name):
  with open(path, encoding="utf-8") as f:
    text = f.read()
  data = parse_frontmatter(path, text)
  if data is None:
    return
  for key in ("name", "description"):
    if not isinstance(data.get(key), str) or not data[key].strip():
      err(path, 1, f"frontmatter missing {key}")
  if data.get("name") != expected_name:
    err(
      path, 1, f"name is {data.get('name')!r}, directory says {expected_name!r}")
  for key in ("mode", "icon", "color", "reminder"):
    if key in data:
      err(
        path, 1, f"frontmatter key {key} is a Cursor chat-mode key, unsupported here")


def listdir(sub):
  d = os.path.join(ROOT, sub)
  return sorted(os.listdir(d)) if os.path.isdir(d) else []


def check_skills():
  for d in listdir("skills"):
    skill_dir = os.path.join(ROOT, "skills", d)
    if not os.path.isdir(skill_dir):
      continue
    skill = os.path.join(skill_dir, "SKILL.md")
    if not os.path.isfile(skill):
      err(skill_dir, 0, "no SKILL.md")
      continue
    if not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", d):
      err(skill_dir, 0, "directory name is not lowercase-hyphen")
    check_frontmatter(skill, d)


def agent_names():
  names = set()
  for f in listdir("agents"):
    if f.endswith(".md"):
      check_frontmatter(os.path.join(ROOT, "agents", f), f[:-3])
      names.add(f[:-3])
  return names


PATH_REF = re.compile(r"`([^`\n]+?\.(?:md|sh|tsv|ts|py|json))`")


def skill_root(path):
  d = os.path.dirname(path)
  while d.startswith(ROOT) and d != ROOT:
    if os.path.isfile(os.path.join(d, "SKILL.md")):
      return d
    d = os.path.dirname(d)
  return ROOT


def check_paths(path, text):
  for n, line in enumerate(text.splitlines(), 1):
    for ref in PATH_REF.findall(line):
      if "/" not in ref or ref.startswith(("http", "~", "$", "/", "<", ".claude")):
        continue
      if any(c in ref for c in "<>*$ "):
        continue
      bases = (os.path.dirname(path), skill_root(path), ROOT,
               os.path.join(ROOT, "skills", "playbook"))
      first = ref.split("/")[0]
      if first == ".." or any(os.path.isdir(os.path.join(b, first)) for b in bases):
        if not any(os.path.exists(os.path.join(b, ref)) for b in bases):
          err(path, n, f"path `{ref}` does not resolve")


AGENT_REF = re.compile(r"`((?:codex|fable|opus)-[a-z0-9-]+)`")
SUBAGENT = re.compile(r"subagent_type[\"'`]?:?\s*[\"'`]([A-Za-z0-9-]+)")


def check_agents(path, text, known):
  for n, line in enumerate(text.splitlines(), 1):
    for name in AGENT_REF.findall(line) + SUBAGENT.findall(line):
      if name not in known and name not in BUILTIN_AGENTS:
        err(path, n, f"agent `{name}` does not exist in agents/")


DASHES = {"\u2014": "em dash", "\u2013": "en dash"}


def check_dashes(path, text):
  for n, line in enumerate(text.splitlines(), 1):
    for ch, name in DASHES.items():
      if ch in line:
        err(path, n, name)


_help_cache = {}


def codex_help(sub):
  if sub not in _help_cache:
    cmd = ["codex"] + ([sub] if sub else []) + ["--help"]
    out = subprocess.run(cmd, capture_output=True, text=True)
    _help_cache[sub] = out.stdout + out.stderr
  return _help_cache[sub]


def flag_known(flag, help_text):
  return re.search(r"(^|[\s,])" + re.escape(flag) + r"([\s,=<]|$)", help_text, re.M) is not None


CODEX_LINE = re.compile(r"\bcodex\s+(?:-\S+\s+\S+\s+)*(exec|review)\b")
CODEX_INVOCATION = re.compile(r"\bcodex\b(?!/)[^`\n]*?\b(exec|review)\b")


def codex_commands(text, pattern):
  lines = text.splitlines()
  i = 0
  while i < len(lines):
    line = lines[i]
    m = pattern.search(line)
    if not m:
      i += 1
      continue
    start = i + 1
    cmd = line[m.start():]
    while cmd.rstrip().endswith("\\") and i + 1 < len(lines):
      i += 1
      cmd = cmd.rstrip()[:-1] + " " + lines[i]
    cmd = re.split(r"<<|`|\s-\s|\s>\s|\s2>", cmd)[0]
    try:
      tokens = shlex.split(cmd)
    except ValueError:
      i += 1
      continue
    yield start, m.group(1), tokens
    i += 1


def check_codex(path, text):
  if not shutil.which("codex"):
    return
  for start, _, tokens in codex_commands(text, CODEX_LINE):
    sub = None
    for tok in tokens[1:]:
      if tok in ("exec", "review") and sub is None:
        sub = tok
        continue
      if not tok.startswith("-") or tok in ("-", "--"):
        continue
      flag = tok.split("=")[0]
      scope = sub if sub else ""
      if not flag_known(flag, codex_help(scope)):
        where = f"codex {sub}" if sub else "codex (global)"
        err(path, start, f"{where} does not accept {flag}")


def config_value(tokens, name):
  prefix = f"{name}="
  for tok in tokens:
    if tok.startswith(prefix):
      return tok[len(prefix):].strip("\"'")
  return None


def codex_subcommand(tokens):
  if len(tokens) < 2 or not tokens[1].startswith("-") and tokens[1] not in ("exec", "review"):
    return None

  for tok in tokens[1:]:
    if tok in ("exec", "review"):
      return tok
  return None


def codex_model(tokens):
  for i, tok in enumerate(tokens):
    if tok in ("-m", "--model") and i + 1 < len(tokens):
      return tokens[i + 1]
  return config_value(tokens, "model")


def table_cells(line):
  return [cell.strip(" `") for cell in line.split("|")[1:-1]]


def codex_efforts():
  path = os.path.join(ROOT, "skills", "playbook", "references", "codex-arms.md")
  try:
    with open(path, encoding="utf-8") as f:
      text = f.read()
  except FileNotFoundError:
    err(path, 0, "reference file is missing")
    return None

  lines = text.splitlines()
  header = ["tier", "-m", "effort", "use"]

  for i, line in enumerate(lines):
    if table_cells(line) == header:
      break
  else:
    err(path, 0, "tier effort table is missing")
    return None

  tiers = {}
  for line in lines[i + 2:]:
    if not line.startswith("|"):
      break
    _, model, effort, _ = table_cells(line)
    tiers[model] = effort

  for _, _, tokens in codex_commands(text, CODEX_INVOCATION):
    if codex_subcommand(tokens) == "review":
      review = config_value(tokens, "model_reasoning_effort")
      if review is not None:
        return tiers, review

  err(path, 0, "review effort is missing")
  return None


def check_codex_effort(path, text, tiers, review):
  for line, _, tokens in codex_commands(text, CODEX_INVOCATION):
    sub = codex_subcommand(tokens)
    if sub is None:
      continue

    effort = config_value(tokens, "model_reasoning_effort")
    if effort is None:
      err(path, line,
          f"codex {sub} invocation does not pin model_reasoning_effort")
      continue

    model = codex_model(tokens)
    expected = tiers.get(model)
    if expected is None and sub == "review" and model is None:
      expected = review
    if expected is not None and effort != expected:
      err(path, line,
          f"codex {sub} invocation pins {effort}, but {model or 'review'} requires {expected}")


def main():
  check_skills()
  known = agent_names()
  effort_config = codex_efforts()
  for path in md_files():
    with open(path, encoding="utf-8") as f:
      text = f.read()
    check_paths(path, text)
    check_agents(path, text, known)
    check_dashes(path, text)
    check_codex(path, text)
    if effort_config is not None:
      check_codex_effort(path, text, *effort_config)
  for e in errors:
    print(e)
  if errors:
    print(f"{len(errors)} error(s)")
    sys.exit(1)
  print("ok")


if __name__ == "__main__":
  main()

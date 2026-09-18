import os
import re

HEADER = re.compile(r"^\*\*\* (Add File|Update File|Delete File): (.+)$")


def files(command, cwd=""):
  out = []
  current = None
  for line in (command or "").split("\n"):
    m = HEADER.match(line)
    if m:
      kind, path = m.groups()
      if not os.path.isabs(path):
        path = os.path.join(cwd, path)
      current = None if kind == "Delete File" else {
        "path": path, "removed": [], "added": []}
      if current:
        out.append(current)
      continue
    if current is None or line.startswith(("*** ", "@@")):
      continue
    if line.startswith("+"):
      current["added"].append(line[1:])
    elif line.startswith("-"):
      current["removed"].append(line[1:])
  return out

import os
import re

HEADER = re.compile(r"^\*\*\* (Add File|Update File|Delete File): (.+)$")


def _hunk(rows):
  while rows and rows[0] == (" ", ""):
    rows.pop(0)
  while rows and rows[-1] == (" ", ""):
    rows.pop()

  return {"old": "\n".join(t for k, t in rows if k != "+"),
          "new": "\n".join(t for k, t in rows if k != "-")}


def files(command, cwd=""):
  out = []
  current = None
  rows = []

  def close():
    if current is not None and any(k != " " for k, _ in rows):
      current["hunks"].append(_hunk(rows))
    rows.clear()

  for line in (command or "").split("\n"):
    if line == "*** End Patch":
      break

    m = HEADER.match(line)
    if m:
      close()
      kind, path = m.groups()
      if not os.path.isabs(path):
        path = os.path.join(cwd, path)
      current = None if kind == "Delete File" else {"path": path, "hunks": []}
      if current:
        out.append(current)
      continue

    if current is None or line.startswith("*** "):
      continue

    if line.startswith("@@"):
      close()
    elif line.startswith(("+", "-")):
      rows.append((line[0], line[1:]))
    elif line == "" or line.startswith(" "):
      rows.append((" ", line[1:]))

  close()

  return out

---
packages:
  skills-cli: minor
---

### ✨ Move a half done plan to another machine

`skills plans move <Project> <id>` packs a DOING plan's commits, edits, untracked files and resume note into one archive and sends it through the hub to a machine named with `--to`, or to any machine, or writes it to the file `--file` names. The checkout is left as it was, the frontier shows the row as moving, and `plans start` refuses it everywhere but the target.

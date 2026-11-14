---
packages:
  skills-cli: patch
---

### 🐛 Eval hide check needs a real miss

`skills eval` now marks a hidden command `HIDDEN` only when a `which` or `command -v` lookup came back empty or printed a miss for it. A lookup Claude Code refused to run, or one that resolved the name to a shell function or alias, reports `UNCHECKED` and fails the run.

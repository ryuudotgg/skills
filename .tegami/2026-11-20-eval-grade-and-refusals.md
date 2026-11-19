---
packages:
  skills-cli: patch
---

### 🐛 A failing eval grade fails the run

`skills eval <case> --grade` now exits 1 when the grader's last line is a failing count or holds no count, and says which in its last `eval failed:` line.

### 🐛 A refused command no longer counts as hidden

The `skills eval` hide check reads `UNCHECKED` for a direct run of the hidden command that Claude Code refused, or whose miss names it only inside a path.

---
packages:
  skills-cli: patch
---

### 🐛 Brief prints the probe that the wave runs

`skills brief`, `plans wave` and `plans lint --overlap` read a plan's `## Probe` the same way, so a sentence above a fenced `rg` command is never printed as the probe. Tab indented lines and `~~~` fences count as probe commands for all three.

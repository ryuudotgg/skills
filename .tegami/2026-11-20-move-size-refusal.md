---
packages:
  skills-cli: patch
---

### 🐛 A move too big for the pack names the real cause

`skills plans move` says `the tracked changes are over 128 MiB` when the tracked diff alone is over the cap, and names the largest untracked file only when untracked files push the work over it.

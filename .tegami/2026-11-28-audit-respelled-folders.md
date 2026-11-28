---
packages:
  skills-cli: patch
---

### 🐛 Audit counts sessions of a checkout renamed to another letter case

`skills audit` counts the sessions a checkout or its T3 Code worktree recorded under another letter case of its folder name, on a disk that ignores case. On a disk that keeps case the two spellings stay separate checkouts.

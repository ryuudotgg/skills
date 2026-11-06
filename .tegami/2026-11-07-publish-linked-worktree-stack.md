---
packages:
  skills-cli: patch
---

### 🐛 `skills publish` stacks a layer from a linked worktree

`skills publish` reads the stack state `gh stack` 0.2.0 and later share across worktrees, and adds a new layer from the worktree that holds its parent instead of failing on `gh stack init`. It now needs `gh stack` 0.2.0 or later.

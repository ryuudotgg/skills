---
packages:
  skills-cli: patch
---

### 🚨 Stacked publishing needs `gh stack` 0.2.0 or later

`skills publish` refuses to publish a stacked layer with an older `gh stack`, so run `gh extension upgrade stack` before the next one.

### 🐛 `skills publish` stacks a layer from a linked worktree

`skills publish` reads the stack state `gh stack` shares across worktrees, and adds a new layer from the worktree that holds its parent instead of failing on `gh stack init`.

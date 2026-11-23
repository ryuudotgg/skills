---
packages:
  skills-cli: patch
---

### 🐛 `skills audit` counts OpenCode write arms

An OpenCode write arm counts as an edit when `skills audit` times a `/plans do` window, and under `--prs` a PR published after one succeeds goes to the arm's `-m` model instead of `lead`. A read only OpenCode arm counts as neither.

### 🐛 `skills audit` times a `-impl` delegate as an edit

A `delegate_task` whose title ends in `-impl` sets the first and last edit of its `/plans do` window, as it already set the implementer under `--prs`.

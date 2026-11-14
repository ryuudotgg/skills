---
packages:
  skills-cli: patch
---

### 🐛 Stacked publish never opens an unreported PR

On a stacked branch, `skills publish` now refuses with `<layer> has no open PR, publish it first` before any push when another layer of the stack has no open PR, instead of letting `gh stack submit` open one with a generated title and body. Merged layers are left out, since submit skips them.

### 🐛 Stacked publish keeps prose that links gh-stack

With the PR body key off, a stacked publish clears an existing PR's body only when it ends with the footer gh-stack writes or matches the repo's PR template, so a description that merely links the gh-stack repository stays.

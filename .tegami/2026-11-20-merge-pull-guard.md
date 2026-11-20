---
packages:
  skills-cli: patch
---

### 🐛 Commit guard blocks merges and pulls that commit

`git merge` and `git pull` are blocked in both modes when they can create a commit, so hands-off mode really blocks every commit. Prs mode points to `git merge --no-commit` then a shaped `git commit -m`, or to `git pull --ff-only`, and those forms, `git merge --squash` and `git merge --abort` still pass.

### 🐛 Forms that cannot commit pass only typed alone

`git cherry-pick -n`, `git revert --no-commit`, `git merge --ff-only` and the other forms that cannot commit pass only as one literal command, so a redirect, a chained command, a later `--` or a shell expansion can no longer slip `--commit` past the commit guard.

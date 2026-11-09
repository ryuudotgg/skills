---
packages:
  skills-cli: patch
---

### 🐛 The commit guard catches cherry-pick, revert and am

`git cherry-pick`, `git revert` and `git am` no longer slip past the commit guard. Hands-off mode blocks them like any commit, and prs mode points to `-n` then a shaped `git commit -m`, or to `git apply` for a patch.

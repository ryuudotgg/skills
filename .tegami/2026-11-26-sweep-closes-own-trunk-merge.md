---
packages:
  skills-cli: patch
---

### 🐛 Sweep closes a stacked layer merged onto the default branch

`plans sweep` closes a row whose PR still names a deleted parent branch as its base once that PR's own merge commit is on the default branch, stamping its own merge, where it used to print `elsewhere`.

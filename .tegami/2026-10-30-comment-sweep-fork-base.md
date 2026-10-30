---
packages:
  skills-cli: patch
---

### 🐛 Comment check skips comments from the branch it was cut from

On a branch cut from another branch such as `staging` with no recorded `skills-base`, the Stop hook lists only the comments this branch adds instead of every comment its parent holds over `main`, and names the base it diffed from.

---
packages:
  skills-cli: patch
---

### 🎨 A stale layer whose work already landed is reported, not rebased

In prs mode, `/plans review` judges a restacked layer against its goal before pushing, and when the base already does the work or a hunk needs a design call, the layer is not pushed and its row stays BLOCKED with `superseded by <short sha>` or `design conflict in <path>`.

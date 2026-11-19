---
packages:
  skills-cli: patch
---

### 🐛 Moves refuse work inside submodules

`skills plans move` refuses, naming the submodule, when a submodule holds edits, untracked files or a commit the branch does not record, instead of printing `moved` for a pack that left that work behind.

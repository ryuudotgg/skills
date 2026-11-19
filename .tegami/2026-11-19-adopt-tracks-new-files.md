---
packages:
  skills-cli: patch
---

### 🐛 Adopted plans keep their new files tracked

`skills plans adopt` marks each file the moved plan added as intent to add, so `git status` shows it as ` A` and `git commit -a` includes it, while modified files still arrive unstaged.

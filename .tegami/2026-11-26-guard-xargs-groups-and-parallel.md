---
packages:
  skills-cli: patch
---

### 🐛 Commit guard follows grouped producers and GNU parallel

The commit guard now blocks a commit or push that `xargs` builds from a group of `echo` and `printf` commands or past a redirect such as `-n 2>/dev/null 1`, and each command GNU `parallel` builds from its `:::` arguments or piped lines.

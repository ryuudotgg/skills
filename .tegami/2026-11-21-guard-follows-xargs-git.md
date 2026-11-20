---
packages:
  skills-cli: patch
---

### 🐛 Commit guard sees git words piped to xargs

A commit, push or `skills.*` git config command that `xargs git` builds from words an `echo` or `printf` pipes to it, or from a here string or heredoc, is now blocked like the same command nested in `sh -c`.

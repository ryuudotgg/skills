---
packages:
  skills-cli: patch
---

### 🐛 Commands piped into a shell stay blocked

The commit guard now blocks a commit, push, PR comment or `skills.*` git config command that is piped into `bash`, `sh` or another shell, or handed to one as a here string, the same way it blocks one inside `bash -c`.

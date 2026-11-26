---
packages:
  skills-cli: patch
---

### 🐛 Commit guard reads locale strings and split git words

The commit guard now blocks a commit or push whose git verb is spelled as a locale string, such as `git $"push"`, or that a producer piped to a shell prints from pieces, such as `printf g$'it push' | sh`.

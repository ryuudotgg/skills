---
packages:
  skills-cli: patch
---

### 🐛 Reviewer settings stay blocked however the key is spelled

The commit guard now blocks a `git config` command on a `skills.*` key even when the key is quoted, escaped or continued onto the next line, and lets a search or message that only mentions such a command through.

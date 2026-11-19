---
packages:
  skills-cli: patch
---

### 🐛 OpenCode catalog reads stop hanging on a held pipe

`skills arms` and the install roster step report a service `opencode` left holding its output within about a second, instead of waiting 15 s for "did not finish", and an `opencode` that ignores SIGTERM no longer outlives the CLI.

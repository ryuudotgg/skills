---
packages:
  skills-cli: patch
---

### 🐛 Dashboard fetch refuses a stuck gh instead of hanging

`skills update` and `skills dash fetch` now refuse within a second when `gh` exits while a child process still holds its output, where they used to wait on that child, and name the signal when `gh` is killed by one.

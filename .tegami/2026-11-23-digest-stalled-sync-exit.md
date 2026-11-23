---
packages:
  skills-cli: patch
---

### 🐛 `skills digest` returns the terminal after a stalled hub sync

When the hub sync `skills digest` runs before writing overruns its limit, the digest prints its line and exits straight away instead of holding the terminal until the stalled sync gives up. Session start and the sync after a write verb exit the same way.

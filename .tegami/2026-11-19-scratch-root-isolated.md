---
packages:
  skills-cli: patch
---

### 🧰 Tests keep plan scratch out of /tmp

Every plan scratch path the CLI makes or cleans resolves under one root, and the test preload points it at a fresh directory for each run, so `bun test` never touches a real `/tmp/plans-<id>`.

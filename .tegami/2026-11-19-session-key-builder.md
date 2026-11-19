---
packages:
  skills-cli: patch
---

### 🧰 One Session key builder in skills-core

skills-core exports `sessionKey` from sessions.ts, and the CLI's sessions code, `sessionKeyOf`, the plan page and the stats page all build Session keys through it.

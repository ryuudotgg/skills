---
packages:
  skills-cli: patch
---

### 🧰 Hook prune and Codex rules tested as units

`pruneHooks` lives in prune-hooks.ts with its own suite on a stub history, and codex-rules.test.ts drives the Codex renderer in process, so install.test.ts spawns `skills install` far less often.

---
packages:
  skills-cli: patch
---

### 🧰 Plans tests share one repo builder

The plans, cross-project, wave and issues tests build their repositories through `initRepo` in test/fixtures.ts with no signing flag, and the session start notify test proves no second update run starts by reading the state file instead of sleeping.

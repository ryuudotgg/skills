---
packages:
  skills-cli: patch
---

### 🧰 One isDirectory and one state file writer

`packages/cli/src/io.ts` exports `isDirectory` and `writeJsonAtomic`, which replace seven private directory checks and the temporary file writers of the heartbeat throttle, the reply guard state, the machine refresh marker and `skills-update.json`, so all four state files now end with a newline.

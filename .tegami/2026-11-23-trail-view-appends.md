---
packages:
  skills-cli: patch
---

### 🎨 Trail writes append instead of rewriting the log

`skills plans log`, `start`, `close` and the other trail writes add their lines to the end of `log.tsv` instead of rebuilding it from every trail event, so they stay quick as the trail grows. Anything that could leave the file out of step with the store still rebuilds it in full.

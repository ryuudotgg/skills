---
packages:
  skills-cli: patch
---

### 🎨 A restack lists the commits a hand resolved rebase dropped or changed

`skills restack-layer` without `--push` now prints a `dropped` line for each commit the rebase left out and a `changed` line for each commit whose patch a hand resolution altered, before its closing line, so the stale layer is judged before anything is pushed.

---
packages:
  skills-cli: patch
---

### 🐛 Single layer fix rounds work on an older git

`skills fix-round` and `skills restack-layer` on a branch with no layer above it no longer refuse with `git replay lacks --ref-action`; only a run that replays an upper layer needs a `git replay` that supports it.

---
packages:
  skills-cli: patch
---

### 🎨 Restore holds one chunk at a time

`skills sessions restore` writes each session chunk by chunk, so restoring a long transcript no longer holds the whole history in memory several times over.

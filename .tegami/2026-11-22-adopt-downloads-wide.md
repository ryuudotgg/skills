---
packages:
  skills-cli: patch
---

### 🎨 Adopt fetches a hub pack's chunks together

`skills plans adopt` now downloads a hub pack's chunks several at a time instead of one after another, so adopting a large move waits on a few rounds of requests rather than one per chunk.

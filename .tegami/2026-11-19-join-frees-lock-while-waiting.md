---
packages:
  skills-cli: patch
---

### 🎨 Hub join leaves hub.lock free while it waits

`skills hub join` holds `hub.lock` only to record its request and to adopt the chain, so syncs and policy changes on the joining machine run while it waits for approval. A join whose store another hub verb enrolled or changed meanwhile refuses and adopts nothing.

### 🐛 A waiting invite prints the device a sync approved

`skills hub invite` prints `device <label> added by <label>` before it returns, also when a background sync approved the join for it.

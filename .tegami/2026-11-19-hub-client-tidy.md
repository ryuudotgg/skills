---
packages:
  skills-cli: patch
---

### 🎨 Restored hubs get their deletions back faster

`skills hub sync` against a hub restored from a backup resends the blob deletions the backup lost several at a time, so a hub with many of them needs fewer partial runs.

### 🧰 Hub client keeps one copy of its byte helpers

The hub client's base64 helpers live in hub/base64.ts, enroll.ts compares bytes with skills-core's `equal`, plans/adopt.ts and plans/pack.ts hash with the `sha256` from plans/store.ts, and names used only in their own file are no longer exported.

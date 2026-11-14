---
packages:
  skills-hub: patch
---

### 🧰 Hub routes share one member access rule

The hub routes admitting only members now name one `MEMBER` access from route.ts, blobs.ts reads a tombstone through one helper, and seven names used only inside their own modules are no longer exported.

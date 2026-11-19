---
packages:
  skills-cli: patch
---

### 🐛 Lease conflicts stay in every `skills hub sync`

`skills hub sync` prints each standing lease conflict and counts it until the lease is broken or the holder releases, including one the sync after a plans verb recorded.

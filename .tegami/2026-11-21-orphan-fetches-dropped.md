---
packages:
  skills-cli: patch
---

### 🐛 A revoked machine's unfetched files stop being downloaded

When a sync quarantines a revision whose bytes have not arrived, it drops the queued download nothing visible still needs, and the first sync after the update drops the ones an older version left queued, so `fetching <n>` in `skills hub status` returns to 0. A revision that becomes visible again queues its bytes again.

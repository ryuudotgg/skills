---
packages:
  skills-cli: patch
---

### 🐛 A revoked machine's unfetched files stop being downloaded

When a sync quarantines a revision whose bytes have not arrived, it drops the queued download nothing visible still needs, so `fetching <n>` in `skills hub status` returns to 0 instead of counting bytes every later sync fetched and refused. A revision that becomes visible again queues its bytes again.

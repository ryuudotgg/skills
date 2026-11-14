---
packages:
  skills-cli: patch
---

### 🐛 `skills pr green` waits for a settled merge state

A PR whose merge state GitHub has not computed yet holds with `mergeability unknown` instead of reading green, and a head that moves on every pass stops at the timeout with exit 1 instead of polling forever.

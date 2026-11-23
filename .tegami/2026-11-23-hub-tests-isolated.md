---
packages:
  skills-cli: patch
---

### 🧰 Hub key and status tests run isolated and fast

The file key store tests in keys.test.ts write only under their own temporary directory with random device ids, and the stalled body status test in verbs.test.ts reaches its deadline in about 250 ms instead of waiting out the 2 s budget.

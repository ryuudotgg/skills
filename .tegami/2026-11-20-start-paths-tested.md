---
packages:
  skills-cli: patch
---

### 🧰 `plans start` lease paths tested through the verb

`start-leases.test.ts` runs `plans start` against a live hub fixture for a held lease, an offline hub, a failed cut and a batch with a held member, and the start rerun check is tested through a real rerun instead of through core's `lastEvent`, with the unused `registeredBelow` helper gone from `stack-verbs.test.ts`.

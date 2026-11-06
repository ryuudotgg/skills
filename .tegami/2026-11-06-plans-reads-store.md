---
packages:
  skills-cli: patch
---

### 🎨 Plans readers work from the store, with or without the views

`plans frontier`, `plans handoff`, `plans wave`, `plans resume`, `threads resume`, `plans lint`, the brief, the sweep, `plans release`, `skills reap` and the session start hook read rows and the trail from `plans.db`, so they keep working when `index.tsv` or `log.tsv` is missing. A store that cannot open makes them refuse with the reason, and `plans sweep`, `plans release` and `skills reap` also refuse while a view holds an edit made outside the store.

---
packages:
  skills-cli: patch
---

### 🎨 Stack verbs, retitle and the audit read the plans store

`fix-round`, `restack-layer`, `lease-rebase`, `pr retitle` and `skills audit` now read rows and trail history from `plans.db`, importing the plans directory on first use, so a hand edit to `index.tsv` or `log.tsv` reaches them only after `skills plans import`. An eval's `plans-after` snapshot keeps the text views and leaves the store out.

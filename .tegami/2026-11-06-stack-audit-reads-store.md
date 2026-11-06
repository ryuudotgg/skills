---
packages:
  skills-cli: patch
---

### 🚨 Stack verbs and the audit see hand edits only after an import

After a hand edit to `index.tsv` or `log.tsv`, run `skills plans import` before `fix-round`, `restack-layer`, `lease-rebase`, `pr retitle` or `skills audit`, since they now read the plans store.

### 🎨 Eval snapshots leave the plans store out

An eval's `plans-after` snapshot keeps the text views and drops `plans.db`, so graders read what they read before.

---
packages:
  skills-cli: patch
---

### 🧰 One check for a draft naming another branch

`closePlan` in `packages/cli/src/plans/verbs.ts` now refuses a landed draft that names another branch than the row's, ahead of the stamp, so `plans close` and the sweep no longer each carry the rule. A `Stamp` takes the branch and the row's history, and a sweep test covers the refusal.

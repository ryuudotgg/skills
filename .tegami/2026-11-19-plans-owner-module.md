---
packages:
  skills-cli: patch
---

### 🧰 Plans verbs share one checkout owner module

The checkout owner rule `skills reap`, `skills device`, `plans schedule` and `threads resume` share now lives in packages/cli/src/plans/owner.ts, lint.ts and overlap.ts reuse the one `PLAN_FILE` and `asciiLower`, and eleven values only their own module reads lose their export.

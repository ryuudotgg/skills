---
packages:
  skills-cli: patch
---

### 🧰 Diff selection covers every live test input

`skills test` on a diff now runs `bun` when only a playbook, an arms reference, CONTRIBUTING.md, an app manifest, a hub compose file or a bun eval case changed, and `dashboard` for every CLI module the spawned CLI loads, which a closure test in selection.test.ts keeps in step. The owner restatement test writes its own `do.md` and `review.md`, and the PTY tests find greptile wherever it sorts among the optional skills.

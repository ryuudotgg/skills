---
packages:
  skills-cli: patch
---

### 🧰 The hung read watch test runs in one second

The spawned `skills pr watch` test in whole-pr.test.ts now runs with `--timeout 1`, checks that its `gh` shim started before the deadline cut the read, and finishes in about a second instead of five.

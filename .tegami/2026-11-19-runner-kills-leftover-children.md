---
packages:
  skills-cli: patch
---

### 🧰 Test commands end their leftover children

packages/cli/src/test/process.ts ends whatever a command left running in its own process group before the result settles, so `skills test` no longer removes a suite's TMPDIR under a background child or waits out the pipe grace for one.

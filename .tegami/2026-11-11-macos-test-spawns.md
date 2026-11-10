---
packages:
  skills-cli: patch
---

### 🧰 macOS test runs stop stalling on fast commands

The test harness starts commands with `Bun.spawn` and settles on its exit promise, since under `bun test` on macOS a `node:child_process` child that exits at once can emit its exit before a listener is attached, and temporary directories are cleaned in process so a git maintenance lock that vanishes mid cleanup no longer fails a test.

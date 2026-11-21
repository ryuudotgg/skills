---
packages:
  skills-cli: patch
---

### 🧰 Pr tests share one fake clock

The pr test suites build their fake clock and watcher dependencies through `fakeClock` and `fakeDependencies` in `packages/cli/src/pr/fakes.ts`, and policy.test.ts reads plain snapshots through `openSnapshot`.

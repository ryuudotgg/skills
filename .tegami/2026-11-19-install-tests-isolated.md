---
packages:
  skills-cli: patch
---

### 🧰 Installer tests ignore your exported settings

The installer fixtures share one environment from `installerEnvironment` in packages/cli/src/test/process.ts, which clears every variable the installer reads, so an exported `SEED_DIRS` or `PLANS_DIR` no longer leaks into a test run. The dashboard lock case waits on a stdin handshake instead of fixed sleeps, and the hung `codex execpolicy check` case calls `applyCodexRules` with a 200 ms timeout.

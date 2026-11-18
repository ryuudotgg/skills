---
packages:
  skills-cli: patch
---

### 🧰 The sessions ledger suite runs in process

packages/cli/src/sessions/ledger.test.ts calls the scan, list and policy verbs and the session start recording directly on a machine built by `ledgerMachine()`, and starts the CLI only for the hook's own output and the OpenCode plugin, so the file runs in under a third of its old time. The test preload drops every `GIT_*` variable, so in process git calls see the fixture checkout even when bun runs inside a git hook.

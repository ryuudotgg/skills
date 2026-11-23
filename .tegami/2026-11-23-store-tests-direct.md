---
packages:
  skills-cli: patch
---

### 🧰 Issue tests run their verbs in process

The issue tests in plans/issues.test.ts call the issue and plans verbs directly with a capturing Io, and spawn the CLI only to prove the verbs are wired and to run the session brief hook. One `captureIo` in test/fixtures.ts replaces the four copies the import, revisions, sync and recall tests kept.

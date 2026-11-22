---
packages:
  skills-cli: patch
---

### 🧰 Hub sync drops its duplicate have reader

`restoreTombstones` reads the hub's tombstones through `holdings`, `BLIND_BYTES` lives once in `packages/cli/src/hub/run.ts`, and `pushBatch`, the test `Wire` and `startHubFixture` lose a result, a counter and an option nothing read.

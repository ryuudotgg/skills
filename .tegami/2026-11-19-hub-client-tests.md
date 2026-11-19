---
packages:
  skills-cli: patch
---

### 🧰 Hub and plans tests share their fixtures

The move, adopt, files and leases tests take their git, store and hub helpers from test/hub-checkout.ts and test/hub-machines.ts, lease tests ask the hub through a fresh leaser after each sync, and `skills plans pin` and `skills plans lease break` have tests for their usage errors and refusals.

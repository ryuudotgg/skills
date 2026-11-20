---
packages:
  skills-cli: patch
---

### 🧰 Backlog sync tests run on simulated time

The wire paced backlog tests in hub/sync.test.ts now run on a Simulated wire in test/hub-machines.ts that moves the Sync clock instead of waiting, so they take seconds and runner load cannot fail them, while `Budget` admission gets direct unit tests in hub/run.test.ts.

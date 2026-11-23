---
packages:
  skills-cli: patch
---

### 🧰 Core tests stamp plan events in one module

The issues, leases, digest, stats, board, frontiers and move tests in packages/core/test build their events through plan-events.ts, so a new stamp field on stored events is set there once.

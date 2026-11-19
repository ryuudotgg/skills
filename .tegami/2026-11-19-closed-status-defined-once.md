---
packages:
  skills-cli: patch
---

### 🧰 Closed status defined once

`isClosed` in packages/core/src/rows.ts is the one rule for DONE and DROPPED, and plan selection, blocker release, lease release, issue folding, the pr and round dedupe and stats all call it instead of keeping their own set.

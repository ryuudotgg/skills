---
packages:
  skills-cli: patch
---

### 🧰 Reviewer kit reads trigger times once

`triggerTimes` in `reviewer-kit.ts` holds the rule for which comments are a reviewer's trigger, and presence and the Greptile, CodeRabbit and Macroscope modules read the times from it.

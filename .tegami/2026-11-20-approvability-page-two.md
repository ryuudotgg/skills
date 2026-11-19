---
packages:
  skills-cli: patch
---

### 🐛 Macroscope waits on a queued approvability check past the first page

On a head with more than 100 checks, a queued `Macroscope - Approvability Check` now reads `wait approval-pending` under the cap, as it does on the first page, so a critical plan can still reach `handback not-approved`.

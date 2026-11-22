---
packages:
  skills-cli: patch
---

### 🐛 Review, eval and brief events reach other machines at once

`skills pr green`, `skills round decide`, `skills round drive`, `skills eval`, `skills brief` and `skills plans wave` now sync with the hub when they finish, so what they record reaches the operator's other machines without waiting for the next unrelated write.

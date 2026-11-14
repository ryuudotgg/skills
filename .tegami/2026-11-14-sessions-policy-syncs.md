---
packages:
  skills-cli: patch
---

### 🐛 A changed sessions policy reaches other machines at once

`skills sessions policy` and `skills sessions scan` now run the short hub sync after they run, like every other verb that writes, so a tightened policy reaches your other machines right away instead of waiting for the next unrelated write or session start.

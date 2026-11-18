---
packages:
  skills-cli: patch
---

### 🐛 Weekly digest counts imported events in the week they happened

`skills digest` places closes and phase times by when each event was recorded, as `/stats` does, so plans whose trail lines were imported after the week ended still show in that week and in the next digest's prior week figures.

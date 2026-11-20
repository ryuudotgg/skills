---
packages:
  skills-cli: patch
---

### 🐛 Re-review triggers are never cut short

`skills round drive` posts each re-review trigger with no deadline, so a trigger GitHub accepted near the hard stop no longer ends the round as `refused`. Every read drive makes keeps its deadline.

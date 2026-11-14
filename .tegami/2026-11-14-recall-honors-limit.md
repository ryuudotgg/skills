---
packages:
  skills-cli: patch
---

### 🐛 `skills recall --limit` prints more than 50 hits

`skills recall <query> --limit <n>` now prints `n` hits whenever that many documents match, where any limit above 50 used to stop at 50.

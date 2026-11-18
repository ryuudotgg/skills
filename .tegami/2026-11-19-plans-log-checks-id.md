---
packages:
  skills-cli: patch
---

### 🐛 `plans log` refuses an id with no row

`skills plans log` now refuses an id the project's index holds no row for, such as `12` for `012`, naming the index and writing nothing, so a handback can no longer land on a row that does not exist. The ad hoc id `-` still logs with no row.

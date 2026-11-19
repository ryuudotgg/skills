---
packages:
  skills-cli: patch
---

### 🐛 An index or trail saved during a plans write keeps its bytes

A plans write that finds `index.tsv` or `log.tsv` saved while it was writing them now keeps the saved file and refuses with the sentence that names `skills plans import`, and `skills plans import` that finds a missing index recreated while it restores it keeps that file and asks to be run again.

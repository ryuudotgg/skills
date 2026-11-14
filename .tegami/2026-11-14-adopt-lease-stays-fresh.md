---
packages:
  skills-cli: patch
---

### 🐛 Slow adopts still check the hub lease

`skills plans adopt` asks the hub for the plan's lease however long its pull and unpack took, so another machine's lease still refuses it and `lease provisional, hub offline` prints only when the hub is really down.

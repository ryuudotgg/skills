---
packages:
  skills-cli: patch
---

### 🐛 Agents rerun a partial hub sync

The hub skill says a `skills hub sync` that exits 75 with a `left` line made progress and should run again until it exits 0, and every line it and the hub verbs print is now in their grammar.

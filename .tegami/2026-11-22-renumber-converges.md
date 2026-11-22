---
packages:
  skills-cli: patch
---

### 🐛 Renumbering one issue on two machines leaves one copy

When two machines run `skills issues renumber` on the same conflict before syncing, the moved issue ends under one number on both once they sync, the number the later renumber gave it, with no duplicate and no new conflict.

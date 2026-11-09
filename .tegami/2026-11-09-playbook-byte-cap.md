---
packages:
  skills-cli: patch
---

### 🎨 The playbook skill costs less per task

The playbook skill every routed task reads in full is about two kilobytes smaller, with its Principles table unpadded, and `skills check` now fails once it grows past a byte cap, naming the remedy: move detail to `references/` or cut.

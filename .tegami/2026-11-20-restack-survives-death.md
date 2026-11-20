---
packages:
  skills-cli: patch
---

### 🐛 A rerun finishes a restack whose push outcome was unknown

When `skills lease-rebase`, `skills fix-round` or `skills restack-layer --push` lands its push but cannot read origin afterwards, running the same command again moves the local branches to the rebased tips origin already holds. It refuses, naming the layer and both recorded tips, when either side moved since.

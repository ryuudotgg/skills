---
packages:
  skills-cli: patch
---

### 🐛 Stack verbs leave the default branch alone

`skills fix-round` and `skills restack-layer` stop with `cannot rebase the default branch <default>` where they used to rebase and push a layer above the current branch that origin calls its default branch, before they stage, rebase or push anything.

---
packages:
  skills-cli: patch
---

### 🐛 Stack verbs leave the default branch alone

`skills fix-round` and `skills restack-layer` refuse `cannot rebase the default branch <default>` when a layer above the current branch is the branch origin calls its default, before they stage, rebase or push anything.

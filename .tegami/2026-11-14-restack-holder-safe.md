---
packages:
  skills-cli: patch
---

### 🐛 Restacks leave a switched holder's branch alone

When a checkout holding a layer switches to another branch while `skills lease-rebase`, `skills fix-round` or `skills restack-layer` moves that layer, the other branch is put back where it was and the run refuses naming both branches, or says it could not restore it.

### 🐛 Lease-rebase refuses every DOING layer it does not own

`skills lease-rebase` refuses any layer with a DOING row outside `SKILLS_OWN_ROWS` before it fetches or moves anything, whether another checkout, the calling one or none holds it.

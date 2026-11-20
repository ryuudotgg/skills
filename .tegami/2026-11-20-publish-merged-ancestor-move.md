---
packages:
  skills-cli: patch
---

### 🎨 Publish names the move for a merged ancestor

`skills publish` on a stacked layer whose parent's PR already merged now refuses with the `skills restack-layer --onto` command that moves the layer onto the trunk, instead of saying the parent has no open PR.

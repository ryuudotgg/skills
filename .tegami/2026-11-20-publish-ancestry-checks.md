---
packages:
  skills-cli: patch
---

### 🐛 Publish without gh stack checks the parent's PR first

Without `gh stack`, `skills publish` on a stacked branch refuses before its first push when the parent branch has no open PR, naming the `skills restack-layer` move when that PR merged, so no PR opens against a dead base.

### 🐛 A merged stack layer no longer blocks a publish

With `gh stack`, a layer it marks merged is left out of the origin tip comparison, so its origin branch running ahead or its local branch being gone no longer refuses the publish of another layer.

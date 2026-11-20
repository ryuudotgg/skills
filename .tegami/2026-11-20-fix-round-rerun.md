---
packages:
  skills-cli: patch
---

### 🐛 A fix round finishes after its push failed

Running the same `skills fix-round` command again after `git push failed` now sends the round commit it left on the branch and restacks the layers above, where it used to refuse that there was nothing to commit.

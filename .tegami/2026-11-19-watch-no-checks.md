---
packages:
  skills-cli: patch
---

### 🐛 `skills pr watch` handles a PR with no checks

A PR whose head has no checks now shows `no checks` in the `--status-only` table, and a polling watch waits two minutes on that head, then decides from GitHub's merge state, so a repository without CI reaches `READY` instead of retrying until it fails.

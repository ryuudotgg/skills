---
packages:
  skills-cli: patch
---

### 🐛 Env values stay redacted after a worktree is removed

`skills hub sync` and `skills sessions show` keep replacing `.env` values in a session whose worktree was merged and removed, reading them from this machine's checkout of the session's project instead.

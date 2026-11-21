---
packages:
  skills-cli: patch
---

### 🎨 `skills reap` and `skills device` work offline

Both read the default branch from the checkout's `origin/HEAD` and ask the remote only when it is unset, so a handback reaps and a device is found again with no network, a failing SSH agent or an unreachable origin.

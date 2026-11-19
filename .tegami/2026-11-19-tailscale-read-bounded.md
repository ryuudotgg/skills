---
packages:
  skills-cli: patch
---

### 🐛 A hung tailscale no longer holds hub status

`skills hub status` and the installer give up on `tailscale status` after two seconds even when tailscale ignores the stop signal or leaves a child holding its output, and report the tailnet as unread.

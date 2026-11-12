---
packages:
  skills-cli: minor
  skills-dashboard: minor
---

### ✨ `skills dash` keeps the hub sync running and shows its state

With a hub configured, `skills dash` syncs at start and every 5 seconds, so events from your other machines appear without a reload, and every view shows `synced`, the queue and conflicts, or `offline:` with the reason `skills hub status` gives. With no hub the dashboard reads `local only` and never contacts one.

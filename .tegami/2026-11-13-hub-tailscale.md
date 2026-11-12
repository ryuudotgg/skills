---
packages:
  skills-cli: patch
  skills-hub: patch
---

### 🎨 Tailscale mode reads your tailnet

In tailscale mode `./install.sh --with hub` reads `tailscale status`, offers the `skills-hub` peers it finds when you join, suggests a free `skills-hub` name when you start a hub, and refuses a hub URL outside `.ts.net` or a machine without Tailscale. `skills hub status` prints `tailnet <name>`, or `offline: tailscale not connected` while the local Tailscale is down.

### 🐛 The Tailscale sidecar keeps its node across restarts

The hub's Tailscale sidecar logs in with its auth key only once, so a restart reuses the saved node instead of logging in again, which a single use key would refuse.

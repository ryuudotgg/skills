---
packages:
  skills-cli: patch
---

### 🐛 The tailscale hub prompt names the tailnet host

`./install.sh --with hub` in tailscale mode asks for the sidecar's MagicDNS name and suggests a `ts.net` URL, and the setup steps say which name the sidecar answers on, so the saved `HUB_URL` is one the new hub serves.

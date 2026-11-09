---
packages:
  skills-cli: minor
---

### ✨ Join or start a plans hub from the installer

`./install.sh --with hub` at a terminal asks whether to join an existing hub or start a new one, then runs the join or prints the compose command and the `skills hub init` step. Without a terminal, `--hub-url` and `--hub-network` write `HUB_URL` and `HUB_NETWORK`, and `--without hub` removes them.

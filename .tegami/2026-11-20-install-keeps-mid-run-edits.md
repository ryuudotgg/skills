---
packages:
  skills-cli: patch
---

### 🐛 Install keeps agent and hook copies saved while it runs

An agent or hook copy that changes while `./install.sh` is deciding whether it owns it is left in place, with a `skip` line saying it changed while install.sh ran, instead of being overwritten or pruned.

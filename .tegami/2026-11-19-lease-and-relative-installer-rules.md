---
packages:
  skills-cli: patch
---

### 🐛 Deny rules stop lease pushes and the relative installer

The permission rules now stop `git push --force-with-lease` and the installer run as `skills/playbook/bin/skills install` or `update` without the leading `./`, in Claude Code, Codex and OpenCode. The entries arrive on the next `./install.sh` or `skills update`.

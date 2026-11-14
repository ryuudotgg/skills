---
packages:
  skills-cli: patch
---

### 🐛 Skill links survive unusual install layouts

`./install.sh` skips a tool directory that resolves to the skills store, so a store at `~/.claude/skills` or behind a symlink keeps every link pointing at the checkout. It also finds the Cursor, OpenCode and Copilot skills directories under a home path with a space, and a rerun leaves a link that already points at the right place untouched.

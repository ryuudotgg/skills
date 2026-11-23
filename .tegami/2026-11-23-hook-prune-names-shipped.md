---
packages:
  skills-cli: patch
---

### 🐛 Hook prune stays quiet about personal files

An install or auto update no longer prints a `skip` line for files, links or folders in `~/.claude/hooks` that this repository never shipped, and leaves them where they are. Retired hook copies still get their `skip` or `prune` line.

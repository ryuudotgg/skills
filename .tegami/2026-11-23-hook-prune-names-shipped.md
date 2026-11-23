---
packages:
  skills-cli: patch
---

### 🐛 Hook prune stays quiet about personal files

An install or auto update no longer prints a `skip` line for files, links or folders in `~/.claude/hooks` that this repository never shipped, and leaves them where they are. A retired hook copy the prune reaches still gets its `skip` or `prune` line.

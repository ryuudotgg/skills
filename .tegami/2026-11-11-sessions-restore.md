---
packages:
  skills-cli: minor
---

### ✨ Pick up another machine's session with `skills sessions restore`

`skills sessions restore` writes each Claude Code or Codex session another machine shared through the hub into this machine's own transcript folders, with that machine's paths moved to your checkout and home, and prints the `claude --resume` or `codex resume` line to continue it. It never overwrites a file the host already has, and `--project` and `--since` narrow what it restores.

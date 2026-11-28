---
packages:
  skills-cli: patch
---

### 🐛 Audit keeps counting a relocated checkout's earlier sessions

`skills audit` in a relocated checkout counts the sessions recorded at its former paths whose transcripts moved with it, and the T3 Code worktrees made under a former folder name.

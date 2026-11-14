---
packages:
  skills-cli: patch
---

### 🐛 Session scans count a moved transcript once

`skills sessions scan` picks up where it left off after a Claude project folder is renamed or `CLAUDE_CONFIG_DIR` or `CODEX_HOME` moves, so a session's tokens no longer double and the move alone records no new stats.

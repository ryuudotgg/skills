---
packages:
  skills-cli: patch
---

### 🐛 Moved transcripts resume their upload

After a project folder rename or a new `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, `skills hub sync` carries on uploading a transcript where it stopped instead of sending the whole history again as a new series. Lines withheld before the move stay withheld.

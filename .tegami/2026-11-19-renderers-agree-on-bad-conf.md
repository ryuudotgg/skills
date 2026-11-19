---
packages:
  skills-cli: patch
---

### 🐛 Rules skip lines name an unreadable skills.conf

When skills.conf cannot be read, the Codex and OpenCode rules skip lines name its path instead of printing `( is invalid)`, and OpenCode no longer offers an empty rule set to paste.

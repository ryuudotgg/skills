---
packages:
  skills-cli: patch
---

### 🐛 Rule notes print on every install

A bad `AGENT_RULES` value or override in skills.conf now prints its note on every install run, machines with only Codex or only OpenCode included, and each note prints once. The Codex rules output no longer says `already holds every skills rule` while it leaves a change on a `left   codex` line.

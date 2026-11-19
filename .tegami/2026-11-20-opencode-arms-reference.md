---
packages:
  skills-cli: patch
---

### 🎨 Codex arms load without the OpenCode reference

A task firing Codex arms no longer reads the OpenCode run line or its permission sets, which now live in the playbook's `opencode-arms.md` and load only when a seat goes to OpenCode.

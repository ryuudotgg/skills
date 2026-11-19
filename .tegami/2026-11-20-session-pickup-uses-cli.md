---
packages:
  skills-cli: patch
---

### 🎨 Session pickup reads prior work through `skills sessions`

A pickup finds the earlier session with `skills sessions list` and reads it with `skills sessions show --digest` on Claude Code and Codex alike, and falls back to the raw transcript, whose Codex location it now names, only when the digest cannot serve.

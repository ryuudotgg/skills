---
packages:
  skills-cli: patch
---

### 🎨 New comments are settled before the code ships

In Claude Code and Codex the commit guard lists new comment lines once before an allowed commit, `skills publish` or `skills fix-round`, so they get deleted or kept before the push instead of after the final reply. A comment already flagged when it was written is not listed again.

### 🎨 A blocked reply comes back whole

When the reply guard blocks, the agent sends its whole reply again and says nothing about the check, so the last message of the turn is the one worth reading.

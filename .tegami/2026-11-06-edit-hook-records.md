---
packages:
  skills-cli: patch
---

### 🎨 Agent edits to plans are kept as revisions

An agent's edit to a plan or ctx file in Claude Code, Codex or OpenCode now lands in `skills plans history` as its own version. When `plans.db` is busy the edit waits in `.revisions-spool/` and is recorded the next time the store opens.

---
packages:
  skills-cli: minor
---

### ✨ Session ledger with `skills sessions scan` and `skills sessions list`

Every Claude Code, Codex and OpenCode session start is recorded in the plans store and linked to the plans on its branch, and `skills sessions scan` reads the token, model and tool counts out of local transcripts so `skills sessions list` can show them per session or per plan.

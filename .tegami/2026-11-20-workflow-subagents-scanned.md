---
packages:
  skills-cli: patch
---

### 🐛 Workflow agents count as subagents

`skills sessions scan` now folds the tokens and tool calls of each Workflow agent into its session's stats and subagent count, and `skills audit` lists Workflow agents in its subagent table, while the `journal.jsonl` beside them is never read as a transcript.

---
packages:
  skills-cli: patch
---

### 🎨 Questions name each host's own tool

A destination question in the playbook and the questions `/plans new` asks now go through `AskUserQuestion` in Claude Code or `request_user_input` in Codex when the turn lists it, and otherwise end the turn on a final message that opens with the question, so a question no longer reads as a finished turn.

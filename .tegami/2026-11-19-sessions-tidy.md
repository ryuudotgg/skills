---
packages:
  skills-cli: patch
---

### 🧰 Quiet sync skips session reads it does not need

The push gate opens `sessions-scan.db` and builds the session policy map only once a session record is pending, a deletion pass with nothing new to tombstone opens no write transaction, `sessions show` reads only its own session's scan row, and the duplicated transcript helpers in packages/cli/src/sessions and packages/cli/src/evals have one copy each.

### 🧰 Eval stubs name the command that ran

A fixture miss in an eval stub now reports `opencode stub:` or `gh stub:` after the command the stub stands in for, where every stub used to say `gh stub:`.

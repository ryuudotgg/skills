---
packages:
  skills-cli: minor
---

### ✨ Plan history with plans show, history and checkout

Every plans verb that reads a plan or ctx file keeps its text as a revision in `plans.db`, and `plans close` keeps the stamped copy across the move into `done/`. `skills plans history` lists the revisions, `skills plans show --at <time>` prints the plan as it stood then, and `skills plans checkout` writes back a plan file that went missing.

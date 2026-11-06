---
packages:
  skills-cli: minor
---

### ✨ Every plan keeps its history

Each plans verb that reads a plan or ctx file keeps its text in `plans.db`, across the move into `done/`. `skills plans history` lists those versions, `skills plans show --at <time>` prints one, and `skills plans checkout` restores a plan file that went missing.

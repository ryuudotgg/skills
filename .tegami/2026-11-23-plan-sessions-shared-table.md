---
packages:
  skills-dashboard: patch
---

### 🧰 Plan page sessions share the sessions table

The plan page draws its Sessions section from `sessionList` through the sessions view's `Table` and `Row`, with its eight columns picked from one keyed cell table, and `planPage` no longer folds sessions of its own. `planSessions` in skills-core keeps a plan's sessions, oldest first.

---
packages:
  skills-cli: patch
---

### 🐛 `plans set-row` REVIEW keeps a row moved during the check

In prs mode `skills plans set-row <Project> <id> REVIEW` writes nothing when another writer changes the row's status, branch or start while its PR is checked, and asks to set REVIEW again, so a row moved to a new branch, closed or started again is never marked REVIEW on the old branch's green result.

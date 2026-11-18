---
packages:
  skills-cli: patch
---

### 🐛 `skills eval` stays inside its run directory when `GIT_DIR` is set

A run started from a shell that exports `GIT_DIR`, `GIT_WORK_TREE` or another repository selector builds and pushes its own repositories and leaves the one those variables name untouched. Other git settings such as `GIT_SSH_COMMAND` still reach the agent and the grader.

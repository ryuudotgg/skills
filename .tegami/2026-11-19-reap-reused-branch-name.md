---
packages:
  skills-cli: patch
---

### 🐛 Reap keeps a new run on a reused branch name

`skills reap` no longer frees an ad hoc branch's simulator, AVD, servers or compose project because an earlier run under the same name handed back: a local branch created after that handback is held until it hands back itself.

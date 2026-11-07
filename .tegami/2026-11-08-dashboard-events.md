---
packages:
  skills-cli: patch
---

### 🎨 Hooks and verbs record their outcomes for the dashboard

Hook blocks, `skills round decide`, `skills pr green`, `skills round drive`, the plans sweep and `skills eval` now record what they decided in the plans store on this machine, a PR or review round only when it changed. None of it reaches `log.tsv`, and a busy or broken store never changes a hook's verdict.

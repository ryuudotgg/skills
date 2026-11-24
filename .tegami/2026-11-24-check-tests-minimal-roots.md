---
packages:
  skills-cli: patch
---

### 🧰 Check tests build only the files their rule reads

The single rule cases in `check.test.ts` write a small root of their own instead of copying the whole tracked tree, so the file runs in about half the time.

---
packages:
  skills-cli: patch
---

### 🧰 Publish drops two leftover parameters

`clearGeneratedBody` in publish/stack.ts takes only the body and the template, and `stageSelected` in publish/commit.ts takes the staged selection its callers already read instead of reading it again.

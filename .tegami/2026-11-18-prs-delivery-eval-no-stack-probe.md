---
packages:
  skills-cli: patch
---

### 🧰 prs-delivery eval expects no gh stack probe

The prs-delivery expectation tells the grader that `skills publish` on a branch cut from the trunk makes no `stack` or `extension` call, matching what publish.test.ts pins, so a run without a `stack --version` line passes.

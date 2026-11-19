---
packages:
  skills-cli: patch
---

### 🧰 Trim the reviewer test suites

The Greptile ledger drops its 18 skipped usage rows, the CodeRabbit case table drops two unread fields, one threshold pattern test in `reviewers/declaration.test.ts` covers all three reviewers, and the round and review suites take their git and result helpers from the shared fixtures, with test names that say what each asserts.

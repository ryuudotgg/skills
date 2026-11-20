---
packages:
  skills-cli: patch
---

### 🧰 Leaner review verb tests

`review.test.ts` drops three tests that repeated another case or checked only their own fake, builds its reviewer declarations with the shared `declarationText`, and halves the thread recheck matrix to the one code path both readers share.

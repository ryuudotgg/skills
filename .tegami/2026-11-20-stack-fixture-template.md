---
packages:
  skills-cli: patch
---

### 🧰 Stack tests copy a prepared repository

`stackRepo` in `test/stack-fixture.ts` builds each repository shape once and gives every test its own copy, and the git shims, the ref snapshot helpers and the three layer spec the stack verb tests repeated now live in that fixture.

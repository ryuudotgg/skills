---
packages:
  skills-cli: patch
---

### 🧰 Short read deadlines wait 60 s under test

While the suite runs, `read` and `readSync` in `packages/cli/src/read.ts` wait at least 60 s before giving up, so a slow `git` or `gh` on a busy runner no longer fails a test that is not about a deadline. The installed CLI keeps every deadline as its caller passed it.

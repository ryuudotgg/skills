---
packages:
  skills-cli: patch
---

### 🧰 Publish and start-close tests copy a prepared repository

`publish.test.ts` and `plans/start-close.test.ts` build their repository once and give every test its own copy. `stackRepo` in `test/stack-fixture.ts` builds and copies through the same `test/repo-template.ts`.

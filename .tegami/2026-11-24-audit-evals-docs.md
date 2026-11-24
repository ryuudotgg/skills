---
packages:
  skills-cli: patch
---

### 🧰 Eval and audit docs match the code

evals/README.md says a run records its `eval` event in the real plans store and names the evidence behind each hide verdict, and CONTRIBUTING.md lists `scripts/audit-memory.ts` with the manual verifiers.

### 🧰 Session folder helpers with no caller are gone

`projectsDir` and `encodedProjectDir` leave packages/cli/src/sessions/claude.ts, and audit.test.ts builds its session folders from `encodedName`.

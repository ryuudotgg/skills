---
packages:
  skills-cli: patch
---

### 🧰 Diff runs of `skills test` run only the tests a change can reach

Without `--all`, the bun suite runs the test files that import a changed file under packages/cli/src or packages/core/src, plus every test that may start repository code as its own process, and still runs every file when the diff holds a change the import graph cannot answer for. The CLI wrapper cases of the stack tests now live in packages/cli/src/stack/wrappers.test.ts, so those files run in process.

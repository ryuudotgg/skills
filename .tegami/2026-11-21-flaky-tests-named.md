---
packages:
  skills-cli: patch
---

### 🧰 `skills test` names flaky tests

When a `bun test` suite that isolates its files fails on five test files or fewer, packages/cli/src/test/runner.ts reruns each of those files once after every other suite has ended and prints a test that then passes as `flaky <file>: <test name>`. A suite whose failures were all flaky counts as `ok`, and the run's last line reads `ok <n> suites, <m> flaky`.

---
packages:
  skills-cli: patch
---

### 🧰 Machine tests build only the fixture they use

machine.test.ts builds a fixture only for the tests that read a store and never builds one twice, and machine-fixture.ts creates its second plans directory only when passed `--two-stores`, which adopt.test.ts does.

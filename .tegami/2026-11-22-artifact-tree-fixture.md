---
packages:
  skills-cli: patch
---

### 🧰 Reap and device tests share one fixture

The reap and device suites build their stub tools, repository and checkout through packages/cli/src/test/artifact-tree.ts and capture a verb's output through its one wrapper.

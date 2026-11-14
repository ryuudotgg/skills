---
packages:
  skills-cli: patch
---

### 🧰 Diff selection runs every suite that reads a changed path

`skills test` now runs bun for an agent definition, bun and typecheck for the OpenCode plugin and reviewer modules, and the dashboard suite for the hub server, the CLI hub client, the plans and sessions verbs and the live hub harness. The deleted-views suite runs its files in parallel.

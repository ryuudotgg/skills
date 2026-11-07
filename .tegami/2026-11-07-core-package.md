---
packages:
  skills-cli: patch
---

### 🧰 Plans logic lives in the skills-core package

The plans event model, type sets, clock, row and trail folds, frontier and view rendering now live in `packages/core`, a dependency free package a browser can bundle, and the CLI store keeps only SQLite and the filesystem. The `core` test suite checks that it bundles for the browser and imports nothing from the CLI or the apps.

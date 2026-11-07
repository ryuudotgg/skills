---
packages:
  skills-cli: patch
---

### 🧰 The CLI lives in packages/cli

The checkout is a Bun workspace with the CLI as the `skills-cli` package under `packages/cli`, its changelog beside it, and `install.sh` installs only that package's runtime dependencies. Contributors install every workspace with `bun install --frozen-lockfile` at the root as before.

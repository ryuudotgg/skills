---
packages:
  skills-cli: patch
---

### 🎨 Stack verbs start fewer git processes

`skills lease-rebase`, `skills restack-layer` and `skills fix-round` read the git common dir, the checkout's git dir and `core.bare` once per run, where every holder check used to read all three again. Each check still finds the holder and reads its HEAD afresh, and what the verbs print is unchanged.

### 🧰 Count the processes a command starts

`scripts/spawn-count.sh <command...>` runs a command with counting shims for `git` and `bun` first on PATH, prints `git <n>` and `bun <n>` once it ends and exits with its status.

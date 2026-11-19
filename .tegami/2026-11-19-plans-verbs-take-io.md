---
packages:
  skills-cli: patch
---

### 🧰 Plans verbs run in process

`plans frontier`, `add`, `log`, `close` and `lint` in verbs.ts take an Io for their output, working directory, environment and project detection, so the close tests drive them in process instead of spawning the CLI.

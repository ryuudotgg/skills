---
packages:
  skills-cli: patch
---

### 🐛 `skills check` reads options as the programs do

A Codex invocation's options count only before `--`, a config value such as the effort counts only when `-c` or `--config` sets it, the last one winning, and a `skills` command that starts with an option other than `--root <dir>` or `--help` is reported as one `skills` does not accept.

---
packages:
  skills-cli: patch
---

### 🐛 `skills check` reads prompt lines in code fences

A fenced command line written with a shell prompt, `$ skills <verb> ...`, now gets the same verb and flag check as the line without the prompt, so a stale `$ skills` example fails the check.

### 🧰 CONTRIBUTING says where the Codex flag check runs

The Checks section states that the Codex flag check reads the installed `codex --help` and is skipped wherever `codex` is not on PATH, the CI Checks job included.

---
packages:
  skills-cli: patch
---

### 🐛 `skills reviewers` usage matches `skills --help`

A bad `skills reviewers` call prints `usage: skills reviewers [--active] (<KEY> | --settings)`, the line `skills --help` lists, and `skills --help` lists `skills audit` with the `-h` and argument names its own usage error prints.

### 🧰 Usage lines live only in the registry

Each verb's usage line is written once in its `packages/cli/src/areas` entry, and the handlers for `round`, `reviewers`, `settings`, `audit`, `eval`, `dash`, `update`, `pr green`, `log` and `check` print that line instead of a copy of their own.

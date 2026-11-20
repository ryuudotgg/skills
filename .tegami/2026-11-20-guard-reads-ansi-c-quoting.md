---
packages:
  skills-cli: patch
---

### 🐛 The commit guard reads ANSI-C quoted git subcommands

A git subcommand spelled with `$'...'` quoting, such as `git $'push'`, `git $'p'ush` or `git $'\x70ush'`, is now judged as the subcommand the shell runs in both modes, so pushes, commits, merges and pulls written that way are blocked like their plain spelling.

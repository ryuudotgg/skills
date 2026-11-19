---
packages:
  skills-cli: patch
---

### 🐛 OpenCode rule removals wait for a confirm unless proven safe

Removing or lowering an owned OpenCode deny or ask now counts as weakening unless a surviving rule provably keeps every command it matched at least as strict, so personal rules that only cover the installer's sample commands no longer let the change through without a terminal confirm.

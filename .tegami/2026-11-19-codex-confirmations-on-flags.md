---
packages:
  skills-cli: patch
---

### 🐛 Flag runs confirm Codex rule changes

`./install.sh` with flags at a terminal now applies a weakening Codex rule change you accepted in the Claude prompt, and asks `Apply these Codex changes?` for the rest, instead of leaving them on `left codex` lines.

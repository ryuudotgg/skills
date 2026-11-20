---
packages:
  skills-cli: patch
---

### 🐛 `skills fast-mode` says why a bad skills.conf reads off

An invalid skills.conf now prints its reason on stderr from `skills fast-mode` too, and the malformed line note reads `<conf>: line <n>: malformed` everywhere, without claiming the whole file is ignored.

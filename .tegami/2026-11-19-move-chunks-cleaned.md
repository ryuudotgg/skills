---
packages:
  skills-cli: patch
---

### 🐛 The hub drops a moved plan's pack once it is no longer needed

A pack `skills plans move` uploads no longer stays on the hub for good: once the move is adopted, started again, replaced by changed work or refused before it records, the machine that ended it deletes the pack's chunks at its next `skills hub sync`.

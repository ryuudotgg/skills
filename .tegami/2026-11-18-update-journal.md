---
packages:
  skills-cli: patch
---

### 🐛 An interrupted `skills update` finishes on the next run

An update killed during its installer or its rollback no longer reads as `current` afterwards. The next `skills update` reruns the installer it stopped in, or refuses with `update lock is held` while that installer is still running.

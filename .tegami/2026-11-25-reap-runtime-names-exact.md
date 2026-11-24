---
packages:
  skills-cli: patch
---

### 🐛 Reap still stops plan servers named like a runtime

`skills reap` now recognises container runtimes by their exact process names, so a plan's own server whose name only starts like one, such as `colima-api`, is reaped as before.

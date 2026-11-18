---
packages:
  skills-cli: patch
---

### 🐛 Merged BLOCKED rows close and their branches hold the wave

`plans sweep` closes a BLOCKED row with a branch once its PR merges into the default branch, and stays quiet about one whose PR is open, closed or missing. `plans wave` holds every ready plan that shares a probe path with such a row, or all of them while its probe cannot run.

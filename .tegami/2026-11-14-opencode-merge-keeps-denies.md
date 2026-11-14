---
packages:
  skills-cli: patch
---

### 🐛 OpenCode asks no longer loosen a personal deny unasked

A managed OpenCode ask that would override part of a personal deny now counts as weakening, even when personal allows for the exact commands sit between them, so a flag run leaves it on a `left` line and only a confirm at a terminal writes it. OpenCode only.

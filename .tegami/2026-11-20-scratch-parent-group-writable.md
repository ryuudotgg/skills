---
packages:
  skills-cli: patch
---

### 🐛 Move and adopt accept a group writable scratch directory

`skills plans move` and `skills plans adopt` now clear the group and other write bits on your own `/tmp/plans-<id>` directory and carry on, so a scratch directory made under umask 002 no longer stops them.

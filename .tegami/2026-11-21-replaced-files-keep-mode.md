---
packages:
  skills-cli: patch
---

### 🐛 Replaced files keep their mode

A view, a plan or ctx copy a sync lands, and a plan `skills plans close` rewrites keep the exact mode they had, so a group writable file stays group writable whatever the umask.

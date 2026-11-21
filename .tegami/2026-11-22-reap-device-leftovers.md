---
packages:
  skills-cli: patch
---

### 🧰 Drop unread reap and device options

`skills device` no longer takes a scratch root it never used, and the named `skills reap` read no longer fills a placeholder branch, since the owner read in owner.ts now takes a base without the scratch root.

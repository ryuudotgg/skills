---
packages:
  skills-cli: patch
---

### 🐛 A failed adopt keeps edits made while it ran

When `skills plans adopt` fails, it undoes only its own changes, so a file edited or created in the checkout while it ran stays as it was. When it cannot switch the checkout back, it leaves the plan's branch in place and says so.

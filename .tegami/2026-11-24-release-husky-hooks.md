---
packages:
  skills-cli: patch
---

### 🐛 Checkouts with husky hooks are released

`skills plans release` now counts husky's generated `.husky/_` as disposable, and treats any directory that ignores itself through its own `.gitignore` as one path. A `PLANS_DISPOSABLE` name with a slash, such as `web/test-results`, matches that many trailing segments of an ignored path.

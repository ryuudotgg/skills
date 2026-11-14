---
packages:
  skills-cli: patch
---

### 🐛 `skills publish` refuses on reads it cannot trust

`skills publish` stops before pushing when it cannot read the branch's origin tip, when a single commit's title breaks the message rule, or when `gh stack` is installed but fails. A branch cut from the trunk no longer asks about `gh stack` at all.

---
packages:
  skills-cli: patch
---

### 🎨 Faster follow-up fixes in `skills audit --prs`

`skills audit --prs` runs one `git blame` per file a fix or revert PR changed instead of one per hunk, so the follow-up fixes table comes back sooner with the same values.

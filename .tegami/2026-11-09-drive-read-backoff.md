---
packages:
  skills-cli: patch
---

### 🐛 Round drive retries its first PR read

`skills round drive` polls a PR read that fails transiently every 30 seconds within `ROUND_DRIVE_CAP` and carries on once one succeeds, printing `wait` only when the cap passes with no read. A GitHub rate limit now shows as `unreadable rate limited` in its wait line and in `skills pr green`'s hold line.

---
packages:
  skills-cli: minor
  skills-dashboard: patch
---

### ✨ Issues filed apart under one number all survive sync

When two machines file the same `<Project>#<n>` while apart, both filings stay after sync, and the INBOX and `skills issues show` print the number as a conflict. `skills issues renumber <Project>#<n>` moves the latest filing to the next free number.

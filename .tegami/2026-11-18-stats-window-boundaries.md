---
packages:
  skills-cli: patch
---

### 🐛 Untimed transcript lines next to a `stats` period stay local

A transcript line with no recorded time now stays on this machine when a `stats` period falls anywhere between the timed lines around it. Loosening a project from `stats` with `skills sessions policy` also refuses when a transcript folder exists but cannot be listed.

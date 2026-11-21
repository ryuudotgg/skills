---
packages:
  skills-cli: patch
---

### 🐛 A slow link no longer times out the speed check of `skills hub sync`

When a long sync resends a pushed blob to measure the link before a large upload, it now stops waiting for that resend at the run's deadline. A link too slow to answer in time ends the run as a partial run with exit 75, where it used to end with `the hub did not answer in time`.

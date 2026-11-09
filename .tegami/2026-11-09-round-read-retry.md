---
packages:
  skills-cli: patch
---

### 🐛 A failed PR read no longer ends the review round as a handback

When `skills round` cannot read the PR because GitHub errored or rate limited it, each reviewer reads `wait unreadable` and the round keeps polling to its deadline, and a PR that is gone or out of reach exits 1 with the reason instead of `handback refused`.

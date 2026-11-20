---
packages:
  skills-cli: patch
---

### 🐛 Session scan ignores quarantined events

`skills sessions scan` files new stats under the newest session event still out of quarantine, and a session whose newest stats were quarantined gets a replacement on the next scan even when its transcript did not change.

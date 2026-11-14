---
packages:
  skills-hub: patch
---

### 🧰 Hub tests cover pairing and lease refusals

The hub suite now checks the expired invite, full invite and full pending table refusals, joiners reading `expired`, a lapsed lease passing to another device, the purge of lease operations after 30 days, and the purge of signature digests after ten minutes, moving time with the hub clock.

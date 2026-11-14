---
packages:
  skills-hub: patch
---

### 🧰 Hub tests cover pairing and lease refusals

The hub suite now checks the expired invite, full invite and full pending table refusals, joiners reading `expired`, a lapsed lease passing to another device, and the 30 day purge of lease operations and signature digests, moving time with the hub clock.

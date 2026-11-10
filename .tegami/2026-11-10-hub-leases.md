---
packages:
  skills-cli: minor
---

### ✨ One plan runs on one machine at a time

With a hub, `skills plans start` refuses a plan another machine holds, records a provisional lease when the hub is offline, and `skills plans pin` reserves a plan for up to 30 days. The frontier names the machine holding each plan, and `skills plans lease break` settles a conflict.

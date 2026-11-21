---
packages:
  skills-cli: patch
---

### 🐛 Events from a newly joined machine are no longer lost

A sync tries the events it could not verify again whenever a machine joins or is revoked, so events from a machine that joined during another machine's sync land on that other machine's next sync instead of staying refused for good.

---
packages:
  skills-cli: patch
---

### 🎨 `skills hub join` enrolls a store whose device keys are gone

On a store whose device keys did not come with it, `skills hub join` now holds the old device, joins under the invite as a new device and names the old one to revoke, the way `skills hub recover` does, instead of refusing that the keys are missing.

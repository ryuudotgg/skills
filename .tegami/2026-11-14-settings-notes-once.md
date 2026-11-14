---
packages:
  skills-cli: patch
---

### 🐛 `skills round` names an unknown `skills.conf` key once

An unknown key in `skills.conf` now gets one `settings:` line from `skills round`, where it used to repeat once per active reviewer. `PLANS_DISPOSABLE` counts as a known key, so neither `skills round` nor `skills settings` calls it unknown anymore.

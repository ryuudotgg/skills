---
packages:
  skills-cli: patch
---

### 🐛 A lost recovery rotation is always reported

When a background sync settles a recovery rotation whose code was never shown, the next `skills hub sync`, `invite`, `revoke` or `recovery rotate` now prints the line telling you to rotate again, instead of the notice vanishing into the quiet run.

---
packages:
  skills-cli: patch
---

### 🐛 Quarantine keeps every revoked device of a store

A store revoked as one device, enrolled again and revoked as the next now counts both devices' events in `quarantined <n>`, and `skills hub sync --publish-quarantine` republishes them all instead of only the first device's.

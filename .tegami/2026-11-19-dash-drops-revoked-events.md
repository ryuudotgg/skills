---
packages:
  skills-cli: patch
  skills-dashboard: patch
---

### 🐛 An open dashboard drops revoked events without a reload

When a hub sync quarantines events a revoked device wrote, or restores ones it had quarantined, an open `skills dash` page catches up within one feed poll instead of keeping what it already showed.

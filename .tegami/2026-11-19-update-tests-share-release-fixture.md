---
packages:
  skills-cli: patch
---

### 🧰 Update tests share the dashboard release fixture

The `skills update` suite builds its dashboard releases through the shared `dashboardRelease` test helper, so packing a build, its asset stubs and its broken sums live in one place.

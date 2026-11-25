---
packages:
  skills-cli: patch
---

### 🧰 Run dashboard test files in parallel

The dashboard suite runs its files with `--parallel`, which cuts it from about 58 s to 38 s locally and lets a failing file get the flaky rerun, and the live view's bun, dashboard and hub estimates match measured run times.

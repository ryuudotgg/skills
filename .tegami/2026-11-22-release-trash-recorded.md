---
packages:
  skills-cli: patch
---

### 🐛 `plans release` removes leftover trash wherever it sits

A run that could not delete the paths it parked now records them under the plans directory, and the next run without `--dry-run` deletes them or puts them back, also when the released checkout was the last one in its parent directory.

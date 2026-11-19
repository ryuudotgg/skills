---
packages:
  skills-cli: patch
---

### 🎨 Configuration reference states the hub repeat rule

The Hub section of the configuration reference says a repeated `HUB_URL` or `HUB_NETWORK` in `skills.conf` uses its last line, as `AUTO_UPDATE` does.

### 🧰 One reader for skills.conf values

The skills.conf key readers in packages/cli/src take their values from `confValues` in delivery.ts instead of each filtering and slicing `KEY=` rows.

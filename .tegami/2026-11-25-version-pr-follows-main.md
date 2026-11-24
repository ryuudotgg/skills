---
packages:
  skills-cli: patch
---

### 🧰 The version PR follows main

The Release workflow runs for every push to main and updates the version PR, so it holds every pending note without a manual run.

### 🧰 Publish tags past a late note

Publish warns about a note merged after the version PR was cut and tags the release anyway, so the next version lists that note and no revert is needed.

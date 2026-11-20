---
packages:
  skills-cli: patch
---

### 🧰 Core's lastEvent reads every event

`lastEvent` in skills-core returns the newest trail line of a row with no list of events to skip, since no caller passes one; the store's `lastTrailEvent` keeps its own.

---
packages:
  skills-cli: patch
---

### 🐛 A slow reap no longer fails other plans verbs

`plans start`, `plans adopt`, `plans sweep`, `plans release` and a second `skills reap` now wait up to 70 seconds for the scratch lock and get it between two steps of a running reap, where they used to stop with `scratch stayed locked` after 10. A reap command that would run past its step's 60 seconds is cut off, and the artifact is listed as kept with a reason naming the limit.

---
packages:
  skills-cli: patch
---

### 🐛 Restored sessions keep the stats of the machine that recorded them

A session `skills sessions restore` wrote adds no stats and uploads no chunks from this machine until a host resumes it here, and from then on its stats are the ones restore found plus what it gains on this machine.

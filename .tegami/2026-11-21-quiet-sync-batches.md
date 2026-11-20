---
packages:
  skills-cli: patch
---

### 🎨 Quiet syncs send queued events in batches

A quiet hub sync sends its queued events in as few requests as its 2 seconds allow, so a write verb no longer follows up with one request per event when the hub's speed is unknown.

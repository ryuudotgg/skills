---
packages:
  skills-cli: patch
---

### 🎨 Recall reads only the plan copies that changed

`skills recall` and a long `skills hub sync` now read only the plan and ctx copies whose size or times changed since they were last recorded, so a recall over a large plans directory starts searching sooner.

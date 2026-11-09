---
packages:
  skills-cli: minor
---

### ✨ `/plans new` checks closed plans before writing

`/plans new` searches every project's closed plans with `skills recall` before it writes a batch, skips any plan a done one already landed, and lists what it found under `## Prior work` in the batch's ctx file.

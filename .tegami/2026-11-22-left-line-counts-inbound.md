---
packages:
  skills-cli: patch
---

### 🎨 `skills hub sync` says what is left to pull

A `skills hub sync` that runs out of time while pulling ends its `left` line with `to pull <n> events, <n> blobs`, so a machine catching up on a large store sees those counts fall from run to run.

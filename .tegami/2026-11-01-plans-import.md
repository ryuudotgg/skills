---
packages:
  skills-cli: minor
---

### ✨ `skills plans import` builds the plans store

`skills plans import` copies every index, trail line, plan and ctx file into `plans.db` at the root of the plans directory and proves both views render back byte for byte, and a rerun adds only what changed. Nothing reads the store yet, so every other plans verb behaves as before.

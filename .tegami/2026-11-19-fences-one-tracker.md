---
packages:
  skills-cli: patch
---

### 🐛 Every plan reader skips the same fenced blocks

`plans lint` and `skills recall` treat a tilde block, and a longer fence holding a shorter one, as quoted text, and a `## ` line inside a fenced Probe block no longer drops the `rg` lines after it.

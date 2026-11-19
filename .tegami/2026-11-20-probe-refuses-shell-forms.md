---
packages:
  skills-cli: patch
---

### 🐛 `plans wave` probes what the plan's shell would run

A probe with an unquoted glob in its pattern or a flag, or a `$` or backtick expansion inside double quotes, now shows as unprobed in `plans wave` and `plans lint --overlap` instead of running `rg` on a word the plan's own shell would have rewritten.

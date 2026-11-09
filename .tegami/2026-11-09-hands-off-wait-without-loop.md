---
packages:
  skills-cli: patch
---

### 🎨 Babysit waits without `/loop` on Codex and OpenCode

A hands-off babysit in `drive` or `background` mode on Codex or OpenCode now waits with one foreground `skills pr watch --timeout 540` call, rerun in the same turn on `TIMEOUT`, instead of being told to run a `/loop` skill those hosts lack; `background` runs as `drive` there.

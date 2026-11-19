---
packages:
  skills-cli: patch
---

### 🧰 PTY install tests skip the timers and the full store copy

interactive.test.ts types each answer on the next tick instead of after 40 ms, and its bootstrap case seeds Bun's cache with only the packages `skills-cli` installs in production, walked from packages/cli/package.json, instead of the whole store.

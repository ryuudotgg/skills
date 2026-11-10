---
packages:
  skills-cli: minor
---

### ✨ Stalled plans show as stale

The post tool use and stop hooks record a heartbeat for the plan on the current branch at most every 5 minutes, and `/plans` and the session brief mark a DOING plan with no heartbeat for 30 minutes as `(<label>, stale <n> min)`.

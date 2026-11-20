---
packages:
  skills-cli: patch
---

### 🐛 A row dropped with `plans set-row` stops holding its issues open

`skills plans set-row <Project> <id> DROPPED` now unlinks each listed row from the issues it resolves, so an issue closes as soon as its remaining resolvers are DONE, the same as after `plans close ... DROPPED`.

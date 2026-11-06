---
packages:
  skills-cli: minor
---

### 🚨 Plans writes go through the store, so hand edits to the views refuse

`plans add`, `plans set-row`, `plans start`, `plans close`, `plans sweep`, `plans log` and `threads log` now record every change in `plans.db` and then rewrite `index.tsv` and `log.tsv` from it, importing the plans directory on first use. A hand edit to either file makes the next write refuse until `skills plans import` takes it in, and `plans log` refuses an event name outside the trail's set.

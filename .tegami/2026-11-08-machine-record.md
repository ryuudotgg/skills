---
packages:
  skills-cli: minor
---

### ✨ The plans store knows the machine it runs on

`skills machine show`, `label` and `refresh` print and record this machine's label, OS, tool versions and project checkouts, and the session start hook adds a `Machine` line to the session context and refreshes those facts in the background once a day.

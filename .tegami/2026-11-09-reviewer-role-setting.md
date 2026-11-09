---
packages:
  skills-cli: minor
---

### ✨ Reviewers gain a `role` setting

`skills settings <reviewer>` prints `role=required` by default, and `<REVIEWER>_ROLE=advisory` in `skills.conf` or `skills.<reviewer>.role` in local git config changes it. Nothing acts on the value yet, so every round ends the way it does today.

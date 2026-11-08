---
packages:
  skills-cli: minor
---

### ✨ Plans can wait on another project's plan

`blocked_by` accepts refs such as `Stanza/168`, checked by `skills plans add`, and the frontier holds the row with `waits on Stanza/168` until that plan is DONE or DROPPED in its own project, while `/plans do` refuses to start it before then.

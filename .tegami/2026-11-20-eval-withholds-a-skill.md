---
packages:
  skills-cli: minor
---

### ✨ Eval runs can leave skills out

`skills eval <case> --without <skills>` runs a case with the named skills missing from the work tree, so running it both ways shows whether a skill changes the grade. The run prints and saves the withheld names and stores no `eval` event.

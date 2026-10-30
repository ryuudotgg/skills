---
packages:
  skills-cli: minor
---

### ✨ Update the checkout with `skills update`

`skills update` moves the skills checkout to the newest verified release on main and reruns the installer, and `skills update --check` says whether one is waiting. It refuses, changing nothing, when the checkout has local work, and puts the old release back if the installer fails.

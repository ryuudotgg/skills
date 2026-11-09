---
packages:
  skills-cli: patch
---

### 🎨 `/plans new` reads the inbox and `/plans do` files issues

`/plans new` runs `skills issues list` in its survey and adds the plan that answers an open issue with `--resolves`. `/plans do` files an issue into another project's inbox when its work needs that project's change, then hands back BLOCKED naming the ref, and the index schema documents plan refs and issue refs in `blocked_by`.

### 🧰 Eval cases can seed the plans store

A case's `seed` file runs `skills` commands against its copied plans directory before the prompt, and the `plans-new-inbox` case uses it to file an issue.

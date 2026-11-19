---
packages:
  skills-cli: patch
---

### 🧰 Pr modules hold each piece once

`GhGitHubReader` reads the origin remote through its injected runner, `pr watch` and `pr green` share `systemClock` from policy.ts, the watch loops share its clamped `remainingBudget`, `reviewerDeclarations` lives in reviewers/declaration.ts, the dead check detail code and unused types are gone, and the `pr green` grammar lists its `rule unmet` line.

### 🎨 Allowed draft note reads plainly

`skills pr watch --allow-draft --pretty` ends a READY on a draft with `note=draft allowed (--allow-draft), leave it a draft and do not mark it ready`.

---
packages:
  skills-cli: patch
---

### 🐛 Stacked merges close once their parent lands

`plans sweep` closes a plan whose PR merged into a parent branch once that parent's PR merges into the default branch, stamping the landed draft with the parent's merge, and `plans start` lets the plans it blocked start on the default branch. A parent whose PRs cannot be read stops the sweep with `unreadable` instead of reporting `elsewhere`.

---
packages:
  skills-cli: patch
---

### 🐛 A merge from before a row's start no longer counts as its PR

`plans set-row ... REVIEW`, `plans stack-base`, `plans start` and `plans below` count only the PRs of a row's current start, so a row started again on a branch that already merged refuses until it has an open PR or one merged after its latest start, instead of passing on the old merge or cutting a dependent from trunk without its work.

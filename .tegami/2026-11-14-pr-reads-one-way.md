---
packages:
  skills-cli: patch
---

### 🐛 `plans close` stamps the row's own merge

`plans close` stamps the newest merge of the row's branch into the default branch since the row started, and refuses a landed draft that names another branch.

### 🐛 Fork PRs no longer count as a row's PR

`plans set-row`, `plans start` and `plans below` ignore a PR from a fork that shares the row's branch name.

---
packages:
  skills-cli: patch
---

### 🎨 `/plans close` says what it reads and refuses

The `/plans close` instructions now say that a DONE close stamping a landed draft reads the default branch from origin and the row's own PRs, stamps the newest merge into the default branch, refuses a landed draft naming another branch, and that a dry run prints the stamped line as `landed: <merged line>`.

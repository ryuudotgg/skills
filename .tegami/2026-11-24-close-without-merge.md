---
packages:
  skills-cli: minor
---

### ✨ Close a plan that shipped outside the repo

`skills plans close <Project> <id> DONE <note> --no-merge` closes a plan whose change shipped outside the repo, such as a production setting, and stamps its landed draft `Closed without a merge (branch <branch>).` instead of a merge. It refuses while the branch holds a commit the default branch lacks or has its own PR open or merged.

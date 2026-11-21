---
packages:
  skills-cli: patch
---

### 🐛 `skills hub sync` still sees a project whose `index.tsv` is missing

A project folder the store knows keeps syncing while its `index.tsv` is gone from disk, so an edit to a plan, a ctx file or any other file saved beside the missing view reaches the other machines instead of waiting for the view to come back.

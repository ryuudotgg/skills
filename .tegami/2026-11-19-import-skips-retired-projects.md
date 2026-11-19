---
packages:
  skills-cli: patch
---

### 🐛 `skills plans import` skips a removed project folder

When a project folder is deleted from the plans directory, the import treats that project as retired. It still takes in edits to every other view and file, and it does not recreate the folder.

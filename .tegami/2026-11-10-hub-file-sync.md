---
packages:
  skills-cli: minor
---

### ✨ Hub sync carries every project file

`skills hub sync` now carries every other file under a plans project, such as assets, evidence and baselines, in encrypted 1 MiB chunks, so an edit uploads only the chunks it changed. A `.plansignore` in the plans directory or a project takes gitignore patterns, symlinks are skipped and listed, and a pulled file never replaces a local edit or writes through a symlink.

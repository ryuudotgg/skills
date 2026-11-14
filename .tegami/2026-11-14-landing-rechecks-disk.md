---
packages:
  skills-cli: patch
---

### 🐛 Hub sync keeps plan and ctx edits saved while it lands a pull

`skills hub sync` checks a plan or ctx file again just before it writes a pulled revision over it or moves it into `done`, so an edit saved meanwhile stays on disk and the next sync weighs it against the pull.

### 🐛 Plan and ctx files that cannot land say why

A plan or ctx file that `skills hub sync` cannot land, such as one the CLI cannot read, now prints `refused path <path>: <reason>` on every sync until it lands, where it used to be skipped without a word.

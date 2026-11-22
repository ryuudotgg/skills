---
packages:
  skills-cli: patch
---

### 🐛 Hub sync refuses a pulled file named like a staging file

`skills hub sync` now refuses a file revision whose path looks like a temporary staging file, printing `refused path <path>: the event names a file only plan sync writes`, instead of writing it into the plans directory.

### 🧰 One staged write for views, landing and file sync

View writes, landing, the first import and file sync now stage through `createDurably` and `replaceDurably` in index-tsv.ts, with one staging name from staging.ts and one `isOwnFile` rule in ignore.ts.

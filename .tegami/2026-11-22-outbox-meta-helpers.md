---
packages:
  skills-cli: patch
---

### 🧰 One reader and writer for the plans meta table

`plans/store.ts` owns the read and the write of the meta table, the unused `sequence` sync key is no longer written, and the outbox queries in `plans/outbox.ts` state each rule once.

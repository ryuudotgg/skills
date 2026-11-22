---
packages:
  skills-cli: patch
---

### 🐛 No false fork line while another process adopts a chain entry

`skills hub status`, `devices`, the session brief and the lease calls of `plans start`, `pin`, `adopt` and `lease break` read the checkpoint and the chain from one moment, so they no longer print `fork detected` when another `skills` process adds an entry at the same time.

### 🎨 Expired invites leave the store

An invite nobody used is deleted once it is more than five minutes past its expiry, and a sync with no live invite left stops asking the hub for pending joins.

---
packages:
  skills-cli: patch
---

### 🐛 Issue links and closes stay with their own filing

When two machines file the same issue number apart, `skills issues show` prints each filing with its own state and links, no plan waiting on the number is released until `skills issues renumber` settles it, and the renumber carries the moved filing's state and links to its new ref and points each plan it blocks there.

### 🚨 Update every synced machine together

A machine still on an older `skills` puts every link and close on the earliest filing of a number in conflict, so it can release plans the updated machines still hold: run `skills update` on each machine that syncs the plans store.

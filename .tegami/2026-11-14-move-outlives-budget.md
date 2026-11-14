---
packages:
  skills-cli: patch
---

### 🐛 Hub moves finish however long the upload takes

`skills plans move` and `skills plans adopt` through the hub no longer give up 30 seconds after they start, so a large pack on a slow link reaches the other machine; each request still times out on its own when the hub stops answering.

### 🐛 A failed hub move resumes where it stopped

Running `skills plans move` again after an upload failed sends only the pack chunks the hub does not hold yet, instead of the whole pack under new names.

### 🐛 Moves no longer wait on unrelated hub work

`skills plans move` prints that the move waits to reach the hub only when its own move or the plan's lease has not reached the hub, not because other uploads are still queued.

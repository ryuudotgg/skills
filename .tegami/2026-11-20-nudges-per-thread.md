---
packages:
  skills-cli: patch
---

### 🐛 A shared thread gets one nudge per stall

`/plans resume` and `/plans threads resume` send one message per stall to a thread that a batch's rows or a stack's layers share, and a nudge logged under any of them holds the rest, with the hourly limit and the idle cap counted once for the thread.

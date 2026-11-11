---
packages:
  skills-cli: patch
---

### 🎨 `/plans wave` closes merged plans before it launches

`/plans wave` runs the same sweep as `/plans close` with no id first, so every plan whose PR merged closes and stops holding the rows that share its files, then the wave starts the next set of threads. One prompt closes the last wave and starts the next.

### 🎨 `/plans close` with no id leaves its own thread open

The sweep still settles the threads of the plans it closes, but no longer the thread it runs in, so an orchestration thread stays in your active list. The scheduled sweep task settles its own thread as before.

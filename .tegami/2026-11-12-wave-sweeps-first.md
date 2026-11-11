---
packages:
  skills-cli: patch
---

### 🎨 `/plans wave` runs the close sweep before it launches

`/plans wave` first runs the same sweep as `/plans close` with no id, so each merged plan it closes stops holding the ready plans that share its files before the wave picks what to launch. You no longer run `/plans close` before each wave.

### 🎨 `/plans close` with no id leaves its own thread open

The sweep still settles the threads of the plans it closes, but no longer the thread it runs in, so an orchestration thread stays in your active list. The scheduled sweep task settles its own thread as before.

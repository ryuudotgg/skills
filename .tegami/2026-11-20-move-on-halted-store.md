---
packages:
  skills-cli: patch
---

### 🐛 Moves refuse a store whose sync is stopped

`skills plans move` through the hub now refuses with `move: sync is stopped on this machine, run skills hub sync` before it uploads anything, instead of recording a move that could never reach the hub.

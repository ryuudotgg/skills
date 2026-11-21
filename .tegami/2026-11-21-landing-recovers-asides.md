---
packages:
  skills-cli: patch
---

### 🐛 An edit survives a sync that dies while a close lands

When `skills hub sync` dies after moving an open plan copy out of the way to land a pulled close, the next sync puts that copy back and refuses the landing, so an edit made on this machine no longer stays hidden under a temp name. A copy that an earlier version left behind keeps its old temp name and is not picked up.

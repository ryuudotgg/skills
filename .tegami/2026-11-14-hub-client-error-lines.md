---
packages:
  skills-cli: patch
---

### 🐛 Hub verbs say what happened on a failed call

A hub answer cut off mid read now reports the hub as unreachable, a proxy error is no longer sent twice, and a `skills hub sync` stopped by an item too large to send still prints its landed, conflict and summary lines before the error.

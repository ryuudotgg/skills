---
packages:
  skills-cli: patch
---

### 🐛 Reply leaves a thread open when someone joins as it posts

`skills review reply` reads the thread again after its reply posts, so a comment someone added in the meantime keeps the thread open and the verb exits 1 instead of resolving it.

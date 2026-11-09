---
packages:
  skills-cli: patch
---

### 🐛 Babysits stop for people, not past them

`skills round drive` no longer hands off a green PR that has changes requested, still needs an approval, or has a human comment or review newer than its head: it stops with a line naming which, and the babysit hands the layer to you without answering or resolving what the person wrote.

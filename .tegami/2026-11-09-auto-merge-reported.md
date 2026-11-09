---
packages:
  skills-cli: patch
---

### 🎨 Drive reports armed auto-merge and the merge queue

`skills round drive` prints `#<n> auto-merge armed <method>` and `#<n> in merge queue` when GitHub would land the PR on its own, and `skills pr green` prints the same lines on stderr, so a babysit reply says when a fix round pushed onto an armed or queued PR.

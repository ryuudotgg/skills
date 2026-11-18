---
packages:
  skills-cli: patch
---

### 🐛 Sweep flags checkouts it cannot read

`skills plans sweep` prints `unreadable` and exits 1 when it cannot read a closed plan's PR or compare its checkout with that PR's head, instead of reporting the checkout as `unpushed`.

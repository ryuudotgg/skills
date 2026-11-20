---
packages:
  skills-cli: patch
---

### 🎨 Round gate and decide end inside a foreground call

`skills round gate --wait` and a polling `skills round decide` stop at drive's cap, 570 s by default under `ROUND_DRIVE_CAP`, and clamp every read to 25 s past it, so one call returns within ten minutes and prints `wait` while a reviewer is still pending.

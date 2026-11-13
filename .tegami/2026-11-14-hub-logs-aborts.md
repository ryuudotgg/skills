---
packages:
  skills-hub: patch
---

### 🐛 Hub logs a dropped request as aborted

A request whose connection drops before the hub answers now logs `aborted` in place of a status, and an upload cut off mid body writes no `hub internal error`, so a 500 in the hub's logs always means a real fault.

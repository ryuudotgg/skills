---
packages:
  skills-cli: patch
---

### 🐛 Reap leaves container runtimes running

`skills reap` no longer stops OrbStack, Docker Desktop or another container runtime that listens on a port it forwards for a plan's container, which took Docker down whenever the runtime had been started from a plan's checkout. The plan's containers are still reaped through their compose project.

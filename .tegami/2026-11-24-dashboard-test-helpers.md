---
packages:
  skills-dashboard: patch
---

### 🧰 Dashboard tests share their Shell render and dash start

The dashboard tests render the Shell through `apps/dashboard/test/render.ts` and start `skills dash` through `apps/dashboard/test/dash.ts`, and the no hub case of `sync.test.ts` checks the hub log without its 11 second wait.

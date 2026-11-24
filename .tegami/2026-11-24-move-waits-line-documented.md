---
packages:
  skills-cli: patch
---

### 🎨 Moving a Plan explains a move still waiting on the hub

Moving a Plan now explains `move: the move waits to reach the hub, run skills hub sync`: the sync runs on the machine the plan is leaving before the target adopts, and a store that sync finds restored or copied keeps the move off the hub until its recovery steps are done. Pause safely runs that sync before naming the adopt command.

---
packages:
  skills-cli: patch
---

### 🐛 `/plans wave` and the sweep call T3 tools that exist

In T3 Code, `/plans wave` reads its thread's model with `t3_thread_configure` and the sweep reads a thread's queue with `t3_queue`, and the plans skill's usage lines and resume, batch and sweep sentences match what the CLI prints.

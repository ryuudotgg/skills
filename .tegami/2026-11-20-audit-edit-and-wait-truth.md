---
packages:
  skills-cli: patch
---

### 🐛 Audit times review only windows and subagent waits honestly

`skills audit` no longer reads a review only window as an edit when a read only seat's brief or a prompt mentions `workspace-write`, and its waiting on subagents share now counts the time a foreground Agent call runs.

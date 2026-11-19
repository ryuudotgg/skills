---
packages:
  skills-cli: patch
---

### 🐛 OpenCode confirmations expire when your rules change

A loosened OpenCode rule you accepted at the prompt is no longer written when any personal permission, policy or legacy permission key changed in either global config file after the preview. The group stays as it was and the run names it on a `left` line, so a deny you add later always wins.

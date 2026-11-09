---
packages:
  skills-cli: patch
---

### 🐛 Read only arms start no subagents

The read only block that ends every read only arm's prompt now forbids starting a subagent, a child task or any other model run, so one review or investigation arm stays one reader on every transport.

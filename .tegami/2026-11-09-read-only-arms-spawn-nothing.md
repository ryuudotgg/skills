---
packages:
  skills-cli: patch
---

### 🐛 Read only arms start no subagents

The read only block that ends every read only arm's prompt now forbids starting a subagent, a child task or any other model run, so one review or investigation arm stays one reader on every transport.

### 🧰 Recall test builds the transaction closeIssue takes

The recall test that closes an issue now passes the `Tx` that `closeIssue` takes since 3eef9b9, so typecheck passes again on main after 07ba1a5 landed beside it.

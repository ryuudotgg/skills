---
packages:
  skills-cli: patch
  skills-hub: patch
---

### 🐛 The hub refuses a later event with a zero previous hash

A signed event of sequence 2 or more whose previous hash is zero now gets `event-chain` from the hub and is never stored.

### 🧰 Core checks an authored event by one rule

`verifyEvent` takes a membership and an event and returns nothing, so the hub and the CLI no longer build a tail from the event under test, and the unused `committedRun` is gone from skills-core.

---
packages:
  skills-cli: patch
---

### 🎨 Stop and PostToolUse hooks start faster

A Stop or PostToolUse call that has nothing to record skips loading the plans store, so it finishes about 6 ms sooner.

### 🐛 A DOING plan keeps its heartbeat when index.tsv is missing

The heartbeat reads the branch's DOING rows from the plans store, so a missing or stale `index.tsv` no longer leaves the row looking stale.

---
packages:
  skills-cli: patch
---

### 🧰 Hook tests prove no update run by state

The session start tests that expect no update run read the update state file as soon as the hook returns instead of sleeping 300 ms, and the heartbeat test for the default branch drops the `index.tsv` rows no assertion read.

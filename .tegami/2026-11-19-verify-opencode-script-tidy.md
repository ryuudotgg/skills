---
packages:
  skills-cli: patch
---

### 🧰 OpenCode verifier shares its shell and model helpers

scripts/verify-opencode.ts sends its forced push case through `shellRun` like the other shell cases, and one helper splits the model id for both sessions that need it.

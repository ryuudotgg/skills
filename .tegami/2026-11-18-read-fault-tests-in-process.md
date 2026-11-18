---
packages:
  skills-cli: patch
---

### 🧰 Read fault tests skip two real waits

The PostToolUse and `skills check` cases in read-faults.test.ts inject the held `readSync` failure in process instead of waiting out the 5 s deadline, so the file runs about 10 s faster.

---
packages:
  skills-cli: patch
---

### 🧰 Timing tests hold on loaded runners

The redact test on a four megabyte image now compares its cost to a sixteenth of the image instead of a fixed time, and the lease tests in `leases.test.ts` give real requests a budget only the faked clock spends.

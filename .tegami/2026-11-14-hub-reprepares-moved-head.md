---
packages:
  skills-hub: patch
---

### 🐛 Hub requests survive a device joining or leaving

A request that reaches the hub while a device is admitted or revoked now gets its normal answer, checked against the updated membership, instead of a `chain-moved` refusal, so a `skills hub join` poll no longer fails at the moment its device is admitted.

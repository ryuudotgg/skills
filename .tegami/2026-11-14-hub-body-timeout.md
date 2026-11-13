---
packages:
  skills-cli: patch
---

### 🐛 Hub verbs name a stalled reply instead of a raw timeout

When the hub starts answering but its reply stalls past the deadline, `skills hub` verbs now say the hub did not answer in time, where they used to print `The operation timed out.` with no context.

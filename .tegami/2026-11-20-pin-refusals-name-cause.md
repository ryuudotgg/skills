---
packages:
  skills-cli: patch
---

### 🐛 `skills plans pin` and `skills plans lease break` name a fork

On a store whose membership chain forked, both verbs now refuse with `fork detected`, and with the sentence of any other chain or key failure, instead of `hub offline`, which they keep for a hub they could not reach.

### 🐛 `skills plans pin` leaves a plan that moved while it waited

A pin whose plan moved to another machine while the pin waited on the hub now refuses with `<id> is moving to <label>`, records no pin, and gives back the lease it took, so the target machine can adopt the plan.

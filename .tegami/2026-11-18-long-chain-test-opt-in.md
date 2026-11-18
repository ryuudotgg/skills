---
packages:
  skills-hub: patch
---

### 🧰 The hub suite runs the long chain test on request

The recovery test that signs a chain up to the last epoch now runs only with `HUB_TEST_LONG_CHAIN=1`, and the default run checks the recover route's body cap in membership.test.ts with one large junk entry instead.

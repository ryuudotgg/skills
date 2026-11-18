---
packages:
  skills-hub: patch
---

### 🧰 Drop unused hub request leftovers

The hub's request core loses the unread `logged` match field, the `Context` type parameter and the unreachable `vault-exists` arm in `settled`, with every reply unchanged.

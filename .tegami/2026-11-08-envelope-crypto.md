---
packages:
  skills-cli: patch
---

### 🧰 Hub crypto primitives in skills-core

`skills-core` gains the WebCrypto primitives the opt in hub will share between the CLI and the server: sealed envelopes, subkeys, device and recovery keys, invites, join MACs, request, event and membership signatures, and the protocol version, with fixed vectors in `packages/core/src/crypto/vectors.json`.

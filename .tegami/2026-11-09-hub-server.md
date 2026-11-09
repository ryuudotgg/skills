---
packages:
  skills-cli: patch
---

### 🧰 Hub server in apps/hub

`apps/hub` (`skills-hub`) serves the hub's `/v1` API over one SQLite data directory that holds only ciphertext, public keys, signatures and HMACs, and `packages/cli/src/test/hub-fixture.ts` starts it in process for tests. Nothing ships or calls it yet: the image and the CLI verbs build on it.

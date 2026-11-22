---
packages:
  skills-cli: patch
---

### 🧰 Hub move tests share a smaller pack

The `hubMove` fixture in plans/move.test.ts packs a 2 MiB `big.bin` into three chunks, so the budget test still proves an upload outlives the 1 s sync budget across three serial chunk PUTs while paying about half the wire delay it did.

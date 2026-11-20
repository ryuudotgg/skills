---
packages:
  skills-cli: patch
---

### 🐛 A failed pack write leaves no partial file

`skills plans move --file` that fails while writing the pack now removes the half written temporary file beside the destination before it refuses.

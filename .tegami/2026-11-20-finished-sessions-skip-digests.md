---
packages:
  skills-cli: patch
---

### 🎨 Hub sync skips the digest of a finished session

A long `skills hub sync` reads a finished session's transcript cursor without its digest, and loads the digest only once the transcript has new lines to cut.

---
packages:
  skills-cli: patch
---

### 🐛 Relocated sessions keep redacting after a folder changed case

On a disk that ignores letter case, a session recorded under a checkout folder's old capitalisation still reads its `.env` values at the checkout's new place, so a `.env` in a subdirectory keeps redacting.

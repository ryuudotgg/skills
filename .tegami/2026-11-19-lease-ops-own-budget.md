---
packages:
  skills-cli: patch
---

### 🐛 Each lease call gets its own time budget

`skills plans pin` with many ids pins every id the hub grants on a slow link, and `plans start` or `plans adopt` takes the lease instead of going provisional when the time budget ran out between its two hub requests.

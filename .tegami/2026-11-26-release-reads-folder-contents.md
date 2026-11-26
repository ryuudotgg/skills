---
packages:
  skills-cli: patch
---

### 🐛 Released checkouts look inside ignored folders

`skills plans release` frees a checkout whose ignored folder holds only disposable entries or empty folders, such as a removed workspace that keeps its `node_modules` or a `.wrangler/` with only `tmp/` in it.

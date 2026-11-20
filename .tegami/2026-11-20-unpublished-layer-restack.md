---
packages:
  skills-cli: patch
---

### 🐛 An unpublished layer follows its merged parent

`skills restack-layer` now rebases a layer origin does not hold yet, `--onto` included, and ends on `then skills publish` with the new parent recorded as its base, where it used to refuse until the layer was published.

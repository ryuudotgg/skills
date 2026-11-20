---
packages:
  skills-cli: patch
---

### 🐛 Stack verbs read git the same under any config

`skills publish` and `skills fix-round` commit signed work with `log.showSignature` on, `skills restack-layer --push` catches a leftover conflict marker whatever the diff settings, and a layer whose name ends like another origin branch counts as not on origin.

---
packages:
  skills-cli: patch
---

### 🎨 Stacking text says what `plans start` and `fix-round` refuse

`/plans do` and the fix round now say that `plans start` checks the layers below and refuses on an open reviewer thread there, fixing nothing, and that `fix-round` refuses any layer above whose row is DOING.

### 🎨 Plan template names `critical:` as optional

The plan file template lists `needs:` and `critical:` as the optional frontmatter lines, with an absent `critical:` meaning false.

### 🎨 Hub status names every problem line to report

The hub skill lists all five problem lines `skills hub status` can print, the revoked and unknown device lines included, and leaves each repair to the operator.

### 🎨 Greptile replies point at the reviewer thread rules

Greptile's reply step points at the reviewer thread rules for every reason `skills review reply` refuses a body.

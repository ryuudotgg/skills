---
packages:
  skills-cli: patch
---

### 🎨 Advisory reviewers no longer hold a layer

`skills round` now leaves an advisory reviewer's wait, re-review, handback or unavailable verdict out of its combined line while a required reviewer is reviewing the head or has reviewed it, so a rate limited or spent advisory bot stops holding the layer. With no required reviewer engaged, advisory reviewers count as required, and with no role set every round reads as before.

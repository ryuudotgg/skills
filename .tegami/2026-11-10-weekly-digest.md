---
packages:
  skills-cli: minor
  skills-dashboard: minor
---

### ✨ Weekly digest with `skills digest`

`skills digest [--week <YYYY-MM-DD>]` writes one digest per ISO week into the plans store: closes, phase times against the prior week, plans that came back from review, recurring hook blocks, the slowest phase, tokens per model, eval regressions and lessons for `/plans new`. With `DIGEST_WEEKLY=on`, `/plans schedule` registers it for Monday at 09:00.

### ✨ Digests page in `skills dash`

The dashboard's Digests view shows one digest per week, newest first, and marks a digest written before its week ended as partial.

### 🐛 Stats leave out projects under policy `off`

A project whose session policy is `off` no longer shows anywhere on the Stats page, so its closes, phase times, hook blocks and reviews stay out like its tokens already did.

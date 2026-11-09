---
packages:
  skills-cli: patch
---

### 🧰 Plans store keeps a full text recall index

`plans.db` migrates to schema 4, which adds FTS5 word and trigram tables over every plan, ctx and closed plan section, trail detail and issue, kept current by the fold at the end of each store write in `packages/cli/src/plans/recall.ts`. No verb reads it yet.

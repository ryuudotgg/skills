---
packages:
  skills-cli: patch
---

### 🧰 Sessions read env values through the relocation record

`plans/relocations.ts` reads and writes `<plans>/relocations.tsv`, and the chunker, the push gate and `sessions show` also read `.env` files at a relocated session directory's new place, so a checkout moved through that record keeps its redaction.

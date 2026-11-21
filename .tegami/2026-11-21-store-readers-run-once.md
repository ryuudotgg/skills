---
packages:
  skills-cli: patch
---

### 🧰 Store reader tests run once

`skills test --all` has no deleted-views suite: the 21 store reader test files run once, in the bun suite. Each test says through its fixture whether `index.tsv` and `log.tsv` stay on disk, with a `views` argument on `writeFixture`, `appendFixture` and `stackCase` that keeps them unless a call passes `"deleted"`.

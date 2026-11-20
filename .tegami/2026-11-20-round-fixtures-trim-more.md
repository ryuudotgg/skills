---
packages:
  skills-cli: patch
---

### 🧰 Trim the round fixtures further

The round's test fixtures drop their duplicate rows, unread fields, the second rate limited PR and the reviewer copies of the usage tests, and `legacy-fixtures.json` writes its 100 commit case with `{repeat, node}`, which `expand` in `fixtures.ts` now spreads inside an array.

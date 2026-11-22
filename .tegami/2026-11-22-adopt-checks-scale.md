---
packages:
  skills-cli: patch
---

### 🐛 Adopt takes files with any name and any count

`skills plans adopt` now adopts a pack with a file named like git pathspec magic, such as `:(review)`, and a pack of any size, where it used to stop with `git ls-files failed`. Its `already adopted here` answer also settles two adoptions on one clock tick the same way on every machine.

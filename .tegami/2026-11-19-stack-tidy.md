---
packages:
  skills-cli: patch
---

### 🧰 Stack verbs and publish share their git plumbing

`skills publish` reads the recorded base through the stack verbs' reader, one write core in src/write.ts backs both process runners, and one `fetchRemoteTip` serves every stack verb's origin read. The push outcome and read fault tests share one three layer spec, and restack.test.ts moved into lease-rebase.test.ts.

---
packages:
  skills-cli: patch
---

### 🐛 Edit guards scan heredocs with a dollar delimiter

A heredoc whose delimiter is written `$'D'` or `$"D"` is now read as a script, so a patch inside it still gets the comment and dash checks. Codex only.

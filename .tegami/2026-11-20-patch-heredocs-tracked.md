---
packages:
  skills-cli: patch
---

### 🐛 Edit guards read every heredoc patch

When one Bash command line opens several `apply_patch` heredocs, the comment guard, the dash guard and plan revision recording now see every patched file, and an `apply_patch` quoted inside a file written through `cat` or `tee` is no longer read as an edit. Codex only.

---
packages:
  skills-cli: patch
---

### 🐛 Push guard ignores an inherited git env

A shell that exports `GIT_DIR`, `GIT_COMMON_DIR` or another repository redirecting variable no longer makes the push guard or the comment check read the wrong repository, so a typed push is judged against the checkout it names.

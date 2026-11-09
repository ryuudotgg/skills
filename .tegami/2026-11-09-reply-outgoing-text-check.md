---
packages:
  skills-cli: patch
---

### 🐛 Review replies refuse home paths and secrets

`skills review reply` now refuses a body that holds a home directory path or a secret, naming the rule and the token, before it reads the thread or posts anything.

---
packages:
  skills-cli: patch
---

### 🐛 The commit guard sees git aliases set through the environment

A git alias set with `GIT_CONFIG_KEY_<n>` or `GIT_CONFIG_PARAMETERS`, as a prefix, after `env`, exported earlier in the command or nested in `sh -c`, now counts as a push in both modes, the same as `git -c alias.<name>=`.

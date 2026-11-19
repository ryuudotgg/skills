---
packages:
  skills-cli: patch
---

### 🐛 Watch names a changes requested review

`skills pr watch` ends a blocked PR whose checks pass but whose review asks for changes as `changes-requested` with exit code 6, instead of reporting failing checks.

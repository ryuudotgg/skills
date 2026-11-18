---
packages:
  skills-cli: patch
---

### 🐛 `skills check` judges review arm invocations

A review arm line is now flag checked even when an option value holds spaces, such as `-C <abs working directory>`, and it fails unless its last `sandbox_mode` config override is `read-only`.

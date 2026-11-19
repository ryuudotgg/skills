---
packages:
  skills-cli: patch
---

### 🐛 Dashboard fetch writes nothing until the build checks out

`skills update` and `skills dash` download and check the dashboard build before they create any directory, so a failed download or a bad sum leaves the dashboard folder untouched, and a slow download can no longer be swept away by another run.

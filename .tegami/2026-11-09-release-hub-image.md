---
packages:
  skills-cli: minor
  skills-hub: minor
---

### ✨ Each release publishes the hub image

Every release pushes `ghcr.io/ryuudotgg/skills-hub:<version>`, built for amd64 and arm64 from the tagged commit, and the newest release also moves `:latest`.

### 🧰 One release for the CLI, the hub and the dashboard

`skills-cli`, `skills-hub` and `skills-dashboard` share one version, tag and GitHub release, and a `.tegami` note may name any of them.

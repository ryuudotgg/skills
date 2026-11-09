---
packages:
  skills-cli: patch
---

### 🎨 Handoff says when the base moved under the PR

When `skills round drive` hands off, it adds how many commits the PR is behind its base and each of the PR's files those commits touched, so you merge knowing what landed underneath. The word stays `handoff`, and a comparison it cannot read prints a note instead.

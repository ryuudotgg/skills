---
packages:
  skills-cli: patch
---

### 🧰 Rule override key and levels have one home

`overrideKey` and the new `levelsFor` live in `packages/cli/src/deny-set.ts`, and the installer, its Customize prompt and the Rule Levels docs table all read them from there.

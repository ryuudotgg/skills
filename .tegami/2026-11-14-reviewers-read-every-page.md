---
packages:
  skills-cli: patch
---

### 🐛 Review rounds read triggers and Macroscope checks on every page

`skills round` now sees a reviewer trigger buried under more than 100 later comments and a `Macroscope - Correctness Check` past the head's first 100 checks.

### 🐛 Macroscope waits when a head check read can succeed later

A head check read that fails for a reason that can pass on retry makes Macroscope read `wait unreadable` instead of `handback refused`, and the other reviewers decide as usual.

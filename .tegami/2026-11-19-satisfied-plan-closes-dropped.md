---
packages:
  skills-cli: patch
---

### 🐛 A plan that turns out unnecessary closes fully

When `/plans do` finds every acceptance criterion already holds, the thread writes the plan's `## Landed` section and runs `plans close ... DROPPED`, so the plan file moves to `done/`, the thread stops counting as live and any issue it resolved loses it as a resolver.

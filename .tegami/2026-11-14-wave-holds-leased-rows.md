---
packages:
  skills-cli: patch
---

### 🐛 Wave holds plans leased on another machine

`skills plans wave` no longer launches a ready plan another device has pinned or whose lease is in conflict. It prints `held <id>: pinned by <label>` or `held <id>: conflict with <label>` instead, the same mark `plans frontier` shows, and a sibling that overlapped only that plan now launches.

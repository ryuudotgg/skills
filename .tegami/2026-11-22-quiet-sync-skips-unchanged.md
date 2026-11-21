---
packages:
  skills-cli: patch
---

### 🎨 An idle `skills hub sync` skips files and leases that cannot have changed

A sync with nothing to send learns that a plans file is unchanged from its size and time without opening it, and settles only the leases it holds or could still hold on the hub, so the quiet sync after each write verb does far less disk and key work on a large plans folder.

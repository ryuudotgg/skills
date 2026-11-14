---
packages:
  skills-cli: patch
---

### 🐛 A waiting hub invite no longer blocks sync

While `skills hub invite` waits for its join, `skills hub sync`, the quiet sync, `plans move`, `plans adopt` and other hub verbs on the same machine run instead of refusing, since the invite holds the store's lock only while it writes.

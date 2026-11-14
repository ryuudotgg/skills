---
packages:
  skills-hub: patch
---

### 🎨 Hub sync requests read only what they answer

The hub answers `/v1/blobs/have` without loading blob contents, stops reading a page of events once it fills the 8 MiB budget, and reports author heads only on an empty history push, so `skills hub sync` holds the hub's write lock for less time on a large store.

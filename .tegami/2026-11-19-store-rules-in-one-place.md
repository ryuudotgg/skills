---
packages:
  skills-cli: patch
---

### 🧰 Plans store rules live in one place

plans/copies.ts holds the copy key rules, the event row decoder and the newest first order, store.ts `renderView` renders both views for every write, round trip and restore, and trail.ts names the trail file once. Disk reads of working copies and views share `readIfPresent`, and `blobBytes` is the only blob reader.

---
packages:
  skills-cli: patch
---

### 🧰 The source clone install test gets a minute on CI

The PTY test that installs from a source clone copies the whole Bun store first, which runs past 30 seconds on the macOS CI runners, so its limit is now 60 seconds like the other slow PTY test.

---
packages:
  skills-cli: patch
---

### 🎨 A copied checkout stops answering to the project it was copied from

A checkout's project pin now remembers the repository it was written for, so a copy pointed at another remote resolves by its other names instead of the original's project, and answers again once its remotes point back. Pins written before keep working, and the next session start or `skills plans start` records their repository.

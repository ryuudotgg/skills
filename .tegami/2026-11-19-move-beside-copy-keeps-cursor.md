---
packages:
  skills-cli: patch
---

### 🐛 A moved transcript keeps its upload place beside a copy

When a session has a copy elsewhere and you rename the project folder holding the transcript that `skills hub sync` uploads, the sync carries on where it stopped instead of uploading the transcript again from its first line, and lines written under `stats` stay local.

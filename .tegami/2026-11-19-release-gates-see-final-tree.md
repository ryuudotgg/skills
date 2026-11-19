---
packages:
  skills-cli: patch
---

### 🧰 Releases refuse notes merged after the version run

The Publish workflow stops before the tag when the release commit still holds a note no changelog section consumed, and the version PR's Tegami Note fails early on the same check, each naming the notes and the recovery in the Releasing section of AGENTS.md.

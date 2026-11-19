---
packages:
  skills-cli: patch
---

### 🧰 Version PR fits the GitHub description limit

The Release run opens the version PR even when the pending notes outgrow the 65,536 character limit GitHub puts on a description. The description drops the text of its last categories first, then lists only as many titles as fit, and the changelog still holds every note.

---
packages:
  skills-cli: patch
---

### 🎨 Session start reads only its own project

The session brief reads its own project's rows and inbox, and stops reading the trail once it has the three lines it prints, so a session start no longer slows down as the plans store grows and an unreadable event in another project no longer replaces the brief with an error.

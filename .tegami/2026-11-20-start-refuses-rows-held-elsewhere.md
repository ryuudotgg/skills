---
packages:
  skills-cli: patch
---

### 🐛 `plans start` leaves batch members and BLOCKED rows alone

`skills plans start <Project> <id>` refuses a row DOING on a batch branch, so the member keeps its commits and its PR, and tells a BLOCKED row why it cannot start by quoting its note.

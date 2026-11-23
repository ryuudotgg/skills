---
packages:
  skills-dashboard: patch
---

### 🎨 Frontier graph shows open plans only

The frontier graph draws open plans and open issues, leaving out done and dropped plans and their blocker lines, so the counts in its label match the picture.

### 🐛 Graph nodes keep the plan id visible

A graph node reads the id and slug over the project and status, so a long project name no longer hides the id, and wide characters and emoji clip by display width without breaking a character.

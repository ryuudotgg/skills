---
packages:
  skills-cli: patch
---

### 🎨 A babysit reruns a drive wait in the same turn

When `round drive` returns `wait`, the prs babysit reruns it right away instead of ending the turn, and stops BLOCKED only when a second rerun prints the same pending lines.

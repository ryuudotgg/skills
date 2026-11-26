---
packages:
  skills-cli: patch
---

### 🐛 Comment scan reads YAML lines of any length

The edit guard and the stop sweep no longer throw or slow down on a YAML line of hundreds of kilobytes, and still report the comment lines that follow it.

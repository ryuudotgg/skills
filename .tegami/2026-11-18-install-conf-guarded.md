---
packages:
  skills-cli: patch
---

### 🐛 Install keeps skills.conf edits made during its prompts

A line added to skills.conf while `./install.sh` waits at a prompt stays in the file next to the choices made there. If the file changes again just before the write, the installer leaves it alone and says so in one `install.sh:` line.

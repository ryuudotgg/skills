---
packages:
  skills-cli: patch
---

### 🐛 Interrogate reviews only the files you name

When `/interrogate` is pointed at specific files or a diff, every reviewer, Codex included, reads only that scope instead of the whole dirty tree, and the code quality lens reports every finding with its severity rather than holding back small ones.

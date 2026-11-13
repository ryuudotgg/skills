---
packages:
  skills-cli: patch
---

### 🐛 `skills hub init` and `skills hub recover` ask for the code at a terminal

At a terminal, `init` without `--code` and `recover` print a prompt, read the code without echoing it and go on after Return, where they used to wait silently for Ctrl-D. An empty line or Ctrl-D stops with a sentence saying how else to pass the code, and a piped code or `--code` works as before.

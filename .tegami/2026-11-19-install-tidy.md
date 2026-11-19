---
packages:
  skills-cli: patch
---

### 🐛 Hub start command quotes paths holding >

The hub start and logs commands the installer prints now single quote a checkout path that holds `<` or `>`, so pasting them no longer redirects the shell.

### 🧰 One shell quoting rule for the installer

The installer, hook commands and session restore quote words through one `shellWord` in shell.ts, `commandFor` renders every hook command, and install.ts stops mutating the rules input it shares with the Codex and OpenCode planners.

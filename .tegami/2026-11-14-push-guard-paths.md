---
packages:
  skills-cli: patch
---

### 🐛 Typed pushes check the repository they push from

In prs mode the commit guard reads a typed push's repository the way the shell resolves it: `git -C ~/<dir> push` expands against your home directory, a Codex push run from a `workdir` is checked there instead of the session's cwd, and a `-C` path that bash and zsh would read differently is refused.

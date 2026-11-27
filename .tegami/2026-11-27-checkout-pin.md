---
packages:
  skills-cli: patch
---

### 🎨 Checkouts keep their project after a rename

When the session start hook or `skills plans start` resolves a checkout by its main folder name, it records the project in the checkout's local git config, so the checkout keeps resolving to that project after its folder is renamed or moved, and so does every linked worktree whose own folder names no project.

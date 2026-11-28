---
packages:
  skills-cli: patch
---

### 🎨 Fresh clones resolve to their project by remote

A checkout whose folder name matches no project now resolves to the project some machine recorded for the same repository, comparing remote URLs by host and path, so a clone under any folder name finds its backlog and the session start hook or `skills plans start` then pins it.

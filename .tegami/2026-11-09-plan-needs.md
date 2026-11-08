---
packages:
  skills-cli: minor
---

### ✨ Plans can say which machines run them

A plan can carry `needs: xcode, docker` and the like in its frontmatter. `plans start` then refuses it on a machine that lacks one and names the machines that can run it, the frontier shows the needs and `--next` skips the plan, `/plans wave` holds it, and `plans lint` names any word outside the set.

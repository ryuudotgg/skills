---
packages:
  skills-cli: patch
---

### 🐛 Playbook spawns leave pinned models alone

The playbook asks for a Task `model` per role unless the agent's frontmatter pins one or a routed skill settles it, which agrees with the panel skills, and its routed skills list now names blast-radius and no-comments. The authoring playbook's model list includes `inherit`.

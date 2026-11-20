---
packages:
  skills-cli: patch
---

### 🐛 Indented frontmatter is checked like frontmatter at column zero

Frontmatter whose keys are all indented now has a repeated key refused and every key's line known, so an optional skill with a doubled `requires` is never installed, `skills check` names the right line, and the OpenCode installer skips such an agent.

---
packages:
  skills-cli: patch
---

### 🐛 The Playbook page shows `bin/skills brief` as code

The Backlog item bullet in the docs site's playbook list renders `bin/skills brief` as inline code, and the page's markdown at `/workflow/playbook.md` and `/llms-full.txt` no longer escapes its backticks.

### 🧰 Docs site builds its tables through one module

The remark plugins under `apps/docs/lib` build their table rows, cells, text and inline code with the builders in `mdast.ts`, and the docs drop the unused locale handling, the Lucide icon plugin and their direct `lucide-react` and `@base-ui/react` dependencies.

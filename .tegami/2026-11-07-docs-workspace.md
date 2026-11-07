---
packages:
  skills-cli: patch
---

### 🧰 Docs site joins the workspace

The docs site lives at `apps/docs` as the `skills-docs` workspace, shares the root `bun.lock`, and imports CLI code through the subpaths that `skills-cli` exports, so one developer install at the root covers it.

---
packages:
  skills-cli: patch
---

### 🧰 Drop dead docs files and share the plugin helpers

The docs app loses its unused page dump script, its `cn` reexport, the unused `TypeTable` and `useMDXComponents` registrations and its `cn` dependency, and its remark plugins share `repoRoot` and `readNamedFrontmatter` from `apps/docs/lib/repo.ts`. The root `.gitignore` drops its Python lines, since the repo holds no Python.

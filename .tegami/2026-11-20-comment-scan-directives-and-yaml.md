---
packages:
  skills-cli: patch
---

### 🐛 Comment checks skip more tool directives

The comment guard and the Stop and commit sweeps no longer count directives for oxlint, Deno lint, stylelint, v8 coverage, pyright, ruff, mypy and RuboCop, a TypeScript `/// <reference` line or a Dockerfile `syntax`, `check` or `escape` line as comments, while prose that merely starts with one of those words still does.

### 🐛 YAML block scalars hold no comments

In `.yaml` and `.yml` files a `#` line inside a `|` or `>` block scalar, such as a shell comment in a GitHub Actions `run: |` step, is string content and no longer reported, and a `#` line after the scalar ends is reported again.

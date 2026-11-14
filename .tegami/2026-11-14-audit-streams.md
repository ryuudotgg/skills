---
packages:
  skills-cli: patch
---

### 🎨 Audit memory stays flat over long histories

`skills audit`, with or without `--prs`, now reads one Claude transcript at a time, so its memory follows the largest transcript rather than the whole selected history. On the same stores, every number, row and note it reports is the same as before.

### 🐛 Audit reads the stores set by CLAUDE_CONFIG_DIR and CODEX_HOME

`skills audit` now finds Claude projects under `CLAUDE_CONFIG_DIR` and Codex sessions under `CODEX_HOME` when either is set, as `skills sessions` already did, and `--project-dir` still overrides the Claude side.

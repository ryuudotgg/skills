---
packages:
  skills-cli: patch
---

### 🐛 Session digests hide secrets added after a turn was saved

Every uploaded session digest redacts its earlier prompts and replies again with the secrets known when it is built, so a value added to a `.env` file later in the session no longer appears in the next chunk's digest.

### 🐛 Session digests list only what you typed

A Claude session's digest no longer shows a compaction summary or a block of local command output as a prompt, in the upload and in `skills sessions show --digest`, the dashboard and `plans adopt`.

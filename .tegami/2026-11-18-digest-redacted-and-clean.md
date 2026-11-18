---
packages:
  skills-cli: patch
---

### 🐛 Session digests hide secrets added after a turn was saved

Every uploaded session digest redacts its earlier prompts and replies again with the secrets known when it is built, so a `.env` value the redactor hides, added later in the session, no longer appears in the next chunk's digest.

### 🐛 Session redaction catches `.env` values in JSON numbers and markers

A `.env` value written as a number on a JSON line, or inside text shaped like `[redacted:<value>]`, now becomes `[redacted:env]` like anywhere else in a transcript.

### 🐛 Session digests list only what you typed

A Claude session's digest no longer shows a compaction summary or a block of local command output as a prompt, in the upload and in `skills sessions show --digest`, the dashboard and `plans adopt`.

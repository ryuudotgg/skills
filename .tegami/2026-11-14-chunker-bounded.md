---
packages:
  skills-cli: patch
---

### 🧰 Transcript reader copies a long line once

`lines` in packages/cli/src/sessions/transcripts.ts keeps an unfinished line as the reads it came in and joins them once at its newline, so a line spanning many reads costs its length instead of its square.

### 🐛 Session upload stops on time past oversized lines

A transcript full of lines too large to upload no longer keeps `skills hub sync` past its deadline: each run sets aside at most one such line once time is up and leaves the rest for the next run.

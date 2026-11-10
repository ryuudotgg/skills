---
packages:
  skills-cli: minor
  skills-hub: patch
---

### ✨ Hub sync uploads session transcripts

`skills hub sync` scans sessions first, then uploads redacted transcript chunks and their digests for every session its project's policy allows, and lowering a project to `stats` or `off` deletes the chunks already sent and prints `deleted <n> blobs`. `skills hub status` adds `transcripts: <n> chunks pending, <m> withheld`.

### 🎨 The hub keeps blobs up to 16 MiB

The hub stores a blob of up to 16 MiB, so a transcript line longer than a mebibyte uploads as one chunk.

---
packages:
  skills-cli: patch
---

### 🧰 One first line reader for the sessions readers

The scan, `readDigest` and the Chunker share one `firstLine` in sessions/transcripts.ts, which reads 64 KiB before it falls back to the Line reader.

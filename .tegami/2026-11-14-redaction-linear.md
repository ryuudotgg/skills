---
packages:
  skills-cli: patch
---

### 🐛 Redaction stays fast on already redacted text

Transcripts that quote earlier redacted output, holding thousands of redaction markers, now redact in time proportional to their length instead of slowing down quadratically.

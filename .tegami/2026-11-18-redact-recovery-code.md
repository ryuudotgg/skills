---
packages:
  skills-cli: patch
---

### 🐛 Session redaction hides hub recovery codes

A hub recovery code in a transcript, spaced as `skills hub init` prints it or hyphenated as typed, in either letter case, now comes back as `[redacted:recovery-code]` in redacted sessions, digests and `skills sessions show`, and `skills publish` and `skills review reply` refuse text that holds one.

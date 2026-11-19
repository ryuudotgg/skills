---
packages:
  skills-cli: patch
---

### 🐛 Spaced tokens are redacted in session text

A hex string or UUID right after a name like `--token`, `--auth-token` or `Bearer`, with only spaces or quotes between, becomes `[redacted:entropy]`, while shas and UUIDs in prose stay untouched.

### 🐛 Basic auth headers are redacted outside curl

The credential of an `Authorization: Basic` header in a log line, a `wget` command or a JSON headers object becomes `[redacted:auth-header]`.

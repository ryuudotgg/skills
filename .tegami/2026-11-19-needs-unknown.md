---
packages:
  skills-cli: patch
---

### 🐛 Plans with unread needs wait instead of starting

A ready plan with no file on disk whose newest revision has no bytes on this machine now shows `needs unknown` in the frontier, and `skills plans start`, `skills plans wave` and ctx batches hold it back instead of starting it as if it had no needs.

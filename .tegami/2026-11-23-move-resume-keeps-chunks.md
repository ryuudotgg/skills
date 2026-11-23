---
packages:
  skills-cli: patch
---

### 🎨 A rerun move keeps the chunks that did not change

Running `skills plans move` again after a failed upload sends only the pack chunks that changed or that the hub lacks, even when a new session id or an edit changed the pack since the last attempt.

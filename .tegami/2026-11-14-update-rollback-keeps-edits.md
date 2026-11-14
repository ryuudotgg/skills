---
packages:
  skills-cli: patch
---

### 🐛 Update rollback never resets over unsaved edits

When `skills update` rolls back a failed release and git cannot snapshot your tracked edits, it now stops with `rollback stopped to keep edits` and leaves the checkout as it is, instead of resetting over them.

### 🐛 Rollback removes what the failed release added

A rollback after a failed `skills update` now prunes the Claude agents and hooks that only the failed release installed, when their bytes still match what it shipped.

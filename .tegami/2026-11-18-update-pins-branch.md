---
packages:
  skills-cli: patch
---

### 🐛 Update leaves a checkout that moved mid run alone

`skills update` checks the checkout again right before it moves it, so a branch switch, a new commit or an edit made while the release was being verified refuses instead of being swept into the update. A rollback after a failed installer no longer resets a branch that was switched to or committed on during the update, and prints `rollback stopped because the checkout moved` instead.

---
packages:
  skills-cli: patch
---

### 🧰 One isFile and one active reviewer rule

The CLI's identical `isFile` copies collapse into the one io.ts exports, and the round, drive, review reply and resolve, `skills reviewers --active` and `skills settings` decide who is active through `isActiveReviewer` in delivery.ts.

### 🧰 Docs build accepts the CLI's .ts imports

The docs tsconfig sets `allowImportingTsExtensions` like every other project in the repo, so the docs type check passes when a CLI module it imports has a value import ending in `.ts`.

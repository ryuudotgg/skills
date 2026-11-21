---
packages:
  skills-cli: patch
---

### 🐛 `skills pr green` stops reading at its timeout

`skills pr green` and the `plans set-row` REVIEW gate count finding the current PR against their timeout and give each GitHub read only the time left, so a stalled `gh` no longer holds them past it. A PR the timeout cuts prints `unreadable timeout reached before reading PR status`.

---
packages:
  skills-cli: patch
---

### 🐛 `skills pr green` keeps a review blocked PR green when only a reviewer check failed

A failed reviewer check under a review block no longer turns the verdict red, and a failed check the list shows prints its `failing` line alone. `blocked <rollup>` now appears only for a failed run the check list hides.

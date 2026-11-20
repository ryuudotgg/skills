---
packages:
  skills-cli: patch
---

### 🧰 Review verbs keep each piece in one place

The resolve write lives in one `resolveThread` in `review/threads.ts`, and each review verb's usage string lives only in `areas/review.ts`, which hands it to the verb through one shared run helper.

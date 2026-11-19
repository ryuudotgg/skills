---
packages:
  skills-dashboard: patch
---

### 🎨 Idle dashboard polls skip decoding the feed

An open dashboard no longer decodes the whole feed again on every poll that brings nothing new, so views that do not read the clock, the sessions list included, keep their results until an event arrives.

### 🧰 One route builder and one poll loop in the dashboard

apps/dashboard/src/links.ts builds every `/plan` and `/sessions` path, `/withheld` and `/sync` share one private loop in client.ts, and views drop the unused `empty` fallback text.

---
packages:
  skills-cli: patch
  skills-hub: patch
---

### 🐛 `skills plans close` finishes on Bun older than 1.4.4

On Bun 1.4.0 through 1.4.3, closing a plan that has a trail no longer stops with `bad parameter or other API misuse` after moving the plan file, and a plan left half closed that way finishes when you run the close again. A hub run from source on those versions also serves the event page after one cut at the byte budget.

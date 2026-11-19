---
packages:
  skills-cli: patch
---

### 🐛 `skills round drive` sees human activity past the newest 100

Before handing off, drive now reads every page of comments and reviews made since the head arrived, so a human comment or review buried under 100 later bot or author entries still stops the call, and an earlier page it cannot read ends in `wait` instead of `handoff`.

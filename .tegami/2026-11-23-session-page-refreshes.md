---
packages:
  skills-dashboard: patch
---

### 🐛 An open session page follows its transcript

An open session page in `skills dash` reads its digest again every 5 seconds, so a transcript that grows shows its new prompts without a `skills sessions scan` or a reload.

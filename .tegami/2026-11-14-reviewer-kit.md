---
packages:
  skills-cli: patch
---

### 🧰 Reviewer modules share one kit

The login matcher, the worst level pick and the open thread read live in `packages/cli/src/round/reviewer-kit.ts`, and CodeRabbit drops its `disabled` skip, which never changed a verdict.

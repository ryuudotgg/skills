---
packages:
  skills-cli: patch
---

### 🐛 Skipped `PR_BODY` and `AGENT_DISCLOSURE` values get a settings note

`skills review reply` and `skills publish` print a `settings:` line on stderr when a `PR_BODY` or `AGENT_DISCLOSURE` value in `skills.conf` or git config is invalid or set twice, so `AGENT_DISCLOSURE=yes` no longer reads as off without a word.

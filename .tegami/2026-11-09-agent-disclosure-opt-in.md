---
packages:
  skills-cli: minor
---

### ✨ Disclose agent posts with `AGENT_DISCLOSURE`

With `AGENT_DISCLOSURE=on` in skills.conf, or `skills.agent-disclosure` in a repository's local git config, each reviewer thread reply and agent written PR body starts with "An agent posted this on behalf of this account." and a blank line. Left unset, replies and bodies post as written.

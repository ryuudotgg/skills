---
packages:
  skills-cli: minor
---

### ✨ Agent written PR bodies with `PR_BODY`

With `PR_BODY=agent` in skills.conf, or `skills.pr-body` in a repository's local git config, `skills publish --body <file>` sets the file as the PR description after the outgoing text check, and keeps any body someone already wrote. Left unset, publish opens every PR with an empty body as before.

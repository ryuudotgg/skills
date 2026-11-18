---
packages:
  skills-cli: patch
---

### 🎨 Security page states the join request limit

The hub Security page now says that anyone who can reach `POST /v1/pair` can fill every join slot for up to a week, which refuses `skills hub join` on a new machine meanwhile, and that a hub reachable only over your tailnet or private network keeps strangers off the route, while a proxy rate limit in `public` mode only slows them.

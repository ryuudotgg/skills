---
packages:
  skills-hub: patch
---

### 🐛 Join requests no longer grow the hub without limit

The hub now admits a join request only while it holds fewer than 1024, live and expired together, deleting the oldest expired ones to make room, and a table over that size from an earlier release shrinks by up to 256 a request, so unauthenticated `POST /v1/pair` calls can no longer fill its database.

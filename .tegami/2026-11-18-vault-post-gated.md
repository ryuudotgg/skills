---
packages:
  skills-hub: patch
---

### 🐛 A founded hub refuses vault posts unread

A hub that already holds a vault answers `POST /v1/vault` with 409 `vault-exists` before it reads the request body, so a caller with no credential can no longer make it hold up to 32 MiB per request.

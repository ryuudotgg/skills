---
packages:
  skills-hub: patch
---

### 🐛 Recovery works on long chains

`skills hub recover` enrolls a device however many epochs the vault has rotated through, where the hub used to refuse its entry as too large once the chain grew long.

### 🧰 The recover read drops its wraps list

`GET /v1/recover` in apps/hub/src/chain.ts answers with the head and the entries only, since no reader used the wraps it also sent.

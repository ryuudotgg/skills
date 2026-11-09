---
packages:
  skills-cli: minor
---

### ✨ Enroll machines in a plans hub

`skills hub init`, `invite`, `join`, `devices`, `revoke`, `recover`, `recovery rotate`, `sync` and `status` found a vault on a hub, enroll and revoke machines, and recover or rotate the recovery code, verifying the membership chain before every signature. Only `join`, `devices`, `status` and `sync` carry an allow rule, since the others change who can read the vault.

---
packages:
  skills-cli: patch
---

### 🧰 Rule groups table moves to its own reference

The installer now reads the permission rule groups from `skills/playbook/references/rule-groups.md`, and `deny-set.ts` names that file in its refusals, so delivery.md carries only the rules an agent acts on.

### 🎨 Waiting `pr green` lines have a next step

The delivery rules now say that a `no checks yet` or `mergeability unknown` line a second full `pr green` run still prints sends the row to BLOCKED, the same as a lasting `pending` or `unreadable` line.

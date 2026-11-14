---
packages:
  skills-cli: patch
---

### 🎨 Each /plans verb loads only its own instructions

A `/plans` subcommand now reads the plans skill's shared rules plus its own verb's references, instead of the whole 89 KB skill, and bare `/plans` reads no reference at all.

### 🧰 Cap the plans skill size

`skills check` fails when `skills/plans/SKILL.md` grows past 22000 bytes, beside the existing playbook cap.

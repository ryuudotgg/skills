---
packages:
  skills-cli: patch
---

### 🚨 Codex invokes hand invoked skills only as $name

Codex no longer lists the hand invoked skills or opens one because a prompt describes it, so saying "challenge this" stops firing `interrogate` there. Type the skill as `$name`, such as `$interrogate`, to open it.

### 🧰 skills check keeps each Codex mirror paired with its flag

`skills check` fails a skill that sets `disable-model-invocation: true` without an `agents/openai.yaml`, and a mirror beside a skill that does not set it, or one holding anything but that policy, naming the file at fault.

---
packages:
  skills-cli: patch
---

### 🐛 Hub reruns print the device's own label

A rerun of `skills hub init` or `skills hub recover` that picks up an enrollment already on the chain names the device by the label every other machine shows, not the `--label` given to the rerun. The default label comes from the same computer name probe as the machine facts, so a hung `scutil` no longer hangs either verb.

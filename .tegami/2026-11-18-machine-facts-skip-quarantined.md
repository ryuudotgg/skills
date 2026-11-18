---
packages:
  skills-cli: patch
---

### 🐛 Quarantined machine events no longer supply facts

A synced `machine` event quarantined as malformed, out of sequence, off chain or revoked no longer gives a machine its checkout paths, capabilities, label or place in a `run on` list, and `skills sessions list` falls back to the newest visible label, or `-`.

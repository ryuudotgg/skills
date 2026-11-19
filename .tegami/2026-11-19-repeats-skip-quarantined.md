---
packages:
  skills-cli: patch
---

### 🐛 Quarantined events no longer hide new pr and round records

A `pr` or `round` event the hub quarantined no longer stops the same outcome from being recorded again, and the newest pick breaks ties the way every other store read does.

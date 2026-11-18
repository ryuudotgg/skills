---
packages:
  skills-cli: patch
---

### 🎨 Architect called by another skill stops at the design

An architect run that another skill or a playbook step started now ends once it has synthesized the design, leaves the sketches unstaged and hands the design back, so the caller implements it. `/architect` typed on its own still goes straight on to implementation.

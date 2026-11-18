---
packages:
  skills-cli: patch
---

### 🐛 Lines written under stats stay local after the policy loosens

`skills hub sync` holds back every transcript line a session wrote while its policy was `stats`, even when no sync ran during that time or the change came from another machine. Loosening a policy with `skills sessions policy` first passes over what the project's sessions already have on disk.

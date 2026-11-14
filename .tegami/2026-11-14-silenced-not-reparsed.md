---
packages:
  skills-cli: patch
---

### 🎨 Session scans skip silenced transcripts

`skills sessions scan` no longer reads the transcripts of a session under an `off` policy, so a silenced project costs the scan at most a file check per transcript, and loosening the policy still records everything written meanwhile.

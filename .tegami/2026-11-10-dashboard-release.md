---
packages:
  skills-cli: minor
  skills-dashboard: minor
---

### ✨ Releases ship the dashboard build

Each release carries the dashboard and a `SHA256SUMS` file, and `skills update`, `./install.sh` and `skills dash` download it, check its sha256 and unpack it into `~/.agents/dashboard/<version>/`. A missing asset or a bad sum prints one line and never fails the update or the install.

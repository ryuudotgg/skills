---
packages:
  skills-cli: minor
---

### ✨ Choose auto updates in `./install.sh`

At a terminal the installer asks whether skills updates itself, off, notify or on, right after the delivery mode, and saves the answer as `AUTO_UPDATE`. `--auto-update off|notify|on` sets it without a prompt, and a run that cannot ask prints a note while the choice is unset or invalid.

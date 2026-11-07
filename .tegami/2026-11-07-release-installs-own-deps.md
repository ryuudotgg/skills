---
packages:
  skills-cli: patch
---

### 🎨 Each release installs its own dependencies

`./install.sh` installs the CLI's runtime dependencies before any of its code runs. From this release on, `skills update` leaves that step to the `install.sh` of the release it moves to, or on rollback the one it returns to.

### 🎨 `skills install` without `@clack` names `./install.sh`

Running `skills install` straight from a checkout whose dependencies are missing now refuses and names `./install.sh`, instead of installing `@clack` and restarting itself.

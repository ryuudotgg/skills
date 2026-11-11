---
packages:
  skills-cli: minor
---

### ✨ Pick up a moved plan on this machine

`skills plans adopt <Project> <id>` takes a plan that `plans move` sent, from the hub or from the file `--file` names, and checks its branch out in this machine's recorded checkout with the moved commits, edits, untracked files and resume note, then takes the lease and prints the `/plans do <id>` line to carry on. A pack that fails its checksum, a dirty checkout, an existing branch or a base origin lacks refuses before anything changes, and a failure partway puts the checkout back as it was.

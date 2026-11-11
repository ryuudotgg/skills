---
packages:
  skills-cli: patch
---

### 🎨 `/plans do` resumes a plan adopted from another machine

`/plans do <id>` on a plan `skills plans adopt` brought onto this machine skips `plans start`, reads the resume note first and carries on from it with the adopted changes left in place. Pause safely runs `plans move` when you name the machine or file the plan goes to, and otherwise names the command in its reply.

### 🧰 Eval baselines get a fixed commit date

`skills eval` commits each case's baseline with a fixed author and date, so a case can ship a plan pack that names it, and the new `plans-do-adopted` case checks the pickup.

### 🧰 CI installs ripgrep from its release

The Ubuntu test job downloads a pinned ripgrep release and checks its sha256 instead of installing it through apt, so an unreachable apt mirror no longer fails every pull request.

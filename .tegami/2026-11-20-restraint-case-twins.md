---
packages:
  skills-cli: patch
---

### 🧰 Restraint evals get control twins

`named-destination` and `stale-assertion` keep the prompts of `wrong-destination` and `weakened-assertion` but make the opposite action correct, so a skill edit that always asks or never touches a test fails a case.

### 🧰 `wrong-destination` grades the gate it runs

Its first expectation now looks for the destination gate's `plans lint` before the question, since the gate runs before `plans start` cuts the branch and a correct run has no branch to show.

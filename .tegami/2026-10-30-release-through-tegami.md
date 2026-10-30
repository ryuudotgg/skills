---
packages:
  skills-cli: major
---

### ✨ Versioned releases

Each release gets a `v<version>` tag and a GitHub release listing what changed, starting at 1.0.0.

### 🧰 Release through Tegami

Running the Release workflow on main opens a version PR from the notes in `.tegami/`, and merging it tags the release. Every PR now needs a note to pass the required Tegami Note check, and the Releases section of `AGENTS.md` says how to write one.

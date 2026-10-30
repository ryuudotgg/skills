## 1.0.0

*October 30, 2026*

### ✨ New

- **Versioned releases** ([#187](https://github.com/ryuudotgg/skills/pull/187))\
  Each release gets a `v<version>` tag and a GitHub release listing what changed, starting at 1.0.0.

### 🧰 Internal

- **Release through Tegami** ([#187](https://github.com/ryuudotgg/skills/pull/187))\
  Running the Release workflow on main opens a version PR from the notes in `.tegami/`, and merging it tags the release. Every PR now needs a note to pass the required Tegami Note check, and the Releases section of `AGENTS.md` says how to write one.

# AGENTS.md

## Releases

The skills release through [Tegami](https://tegami.fuma-nama.dev). Every pull request adds a note in `.tegami/`, internal changes included, and main requires the Tegami Note check that fails until it does.

### Writing a Note

Name the file `.tegami/<date>-<topic>.md`, with the date the note was written and the topic in lowercase words joined by hyphens, such as `2026-10-30-versioned-releases.md`. The date keeps notes in the order they were written, and the version run refuses any other name.

```md
---
packages:
  skills-cli: minor
---

### ✨ Versioned releases

Each release gets a `v<version>` tag and a GitHub release listing what changed.
```

Start each `###` heading with an emoji from this table, a space, then the title:

| Emoji | Category | Use it for                                                                                       |
| ----- | -------- | ------------------------------------------------------------------------------------------------ |
| 🚨    | Heads up | Something people have to act on, such as rerunning `./install.sh` or a renamed `skills.conf` key |
| ✨    | New      | A new skill, command, hook or option                                                             |
| 🎨    | Improved | A change to something that already works: behaviour, speed, wording                              |
| 🐛    | Fixed    | A bug fix                                                                                        |
| 🧰    | Internal | Tests, CI, tooling, dependencies and refactors nobody using the skills would notice              |

The title says what changed for someone using the skills, in a few words.

- Sentence case with no trailing period. Skills, commands and settings keep their names, such as `/plans do` or `AGENT_RULES`.
- Name the outcome, not the work: "Hooks keep working after the checkout moves", not "Fix path resolution in hook-table.ts".
- Internal notes speak to contributors instead: "Release through Tegami".

The body is one plain paragraph of one or two sentences in the present tense, saying what someone notices now. If it only applies somewhere, say where: Codex only, OpenCode only. Leave out "This PR" and issue numbers, and name source files only in internal notes. The changelog links the PR by itself.

A note holds no other headings, lists, tables or code blocks. The version run refuses them, a heading without a category, any heading other than `###`, and text above the first heading. It also refuses a note with no heading at all, and one whose frontmatter names anything but `skills-cli` with a `patch`, `minor` or `major` bump, all of which Tegami would otherwise drop without a warning. `skills check` scans notes like the rest of the markdown, so dashes and unknown `skills` verbs fail there too.

One change per heading. A PR with two unrelated changes gets two headings, each with its own emoji, in one note or in two.

Pick the bump separately from the category:

- `patch` for fixes, internal changes and small changes.
- `minor` for a new skill, command, hook or option.
- `major` for a change that breaks an existing install or config, such as removing a skill or renaming a `skills.conf` key.

### What a Release Looks Like

`CHANGELOG.md` lists each release's notes under the categories, in the order of the table above, with the date. Each title links the PR that added its note, and the body follows on the next line. The link comes from the `(#123)` a squash merge puts in the title of the commit that added the note. A note added by a commit with no PR number links that commit's short sha instead.

### Releasing

`bun run tegami version --dry-run` prints the version the pending notes would produce and checks every note the way the version run does.

- Never edit `CHANGELOG.md`, `.tegami/publish-lock.yaml` or the version in `package.json` by hand. The Release workflow writes them in the version PR.
- Running the Release workflow on `main` opens or updates the `tegami/version-packages` PR, titled `chore: release <version>`, with that version's changelog as its description. Every branch requires signed commits, so the workflow builds the version commit through the GitHub API, which signs it, and moves the branch to it. Checks on a PR the workflow's own token opens or updates wait for approval, so select Approve workflows to run on the version PR to start the ones main requires. It passes Tegami Note without a note of its own.
- Merging the version PR runs the Publish workflow, which tags the merge commit `v<version>` and creates its GitHub release with that version's `CHANGELOG.md` section as the notes.

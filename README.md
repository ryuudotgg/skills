# Ryuu's Skills

Agent skills built around plans on disk, nothing committed or pushed for you, no
worktrees, no slop. The skills are plain markdown and shell, so they work in any agent
that reads a skills directory. Claude Code and Codex are the two they are tested against.
See [what runs where](#what-runs-where).

Forked from [pstack](https://github.com/cursor/plugins/tree/main/pstack) by
[Lauren Tan](https://x.com/poteto), with portions from
[Matt Pocock's skills](https://github.com/mattpocock/skills). If you want the original,
go use pstack.

## Install

```bash
npx skills@latest add ryuudotgg/skills -g
```

Or clone the repo and run `./install.sh`. It symlinks `skills/` into the canonical
store at `~/.agents/skills`, links them into every agent tool it finds, and copies
`agents/` and `hooks/` into `~/.claude`. Safe to re-run. Either way the hooks still
need wiring in `~/.claude/settings.json`. See [hooks](#hooks).

## What Runs Where

`skills/` is plain markdown plus a few POSIX shell scripts. Nothing in it is tied to
one agent, so it works anywhere skills are read. `agents/` and `hooks/` are Claude Code
formats and only load there.

|                             | Claude Code | Codex | Cursor, Copilot, OpenCode           |
| --------------------------- | ----------- | ----- | ----------------------------------- |
| `skills/`                   | yes         | yes   | yes, if the tool reads a skills dir |
| `plans` and its scripts     | yes         | yes   | yes                                 |
| `agents/` wrapper subagents | yes         | no    | no                                  |
| `hooks/`                    | yes         | no    | no                                  |
| `permissions.deny`          | yes         | no    | no                                  |

What that means in practice outside Claude Code:

- The panel skills (`interrogate`, `how`, `architect`) fan out to wrapper subagents.
  Without them the panel degrades to a single pass rather than failing, which each
  skill states in its own steps.
- The guardrails that are `permissions.deny` rules in Claude Code are prose everywhere
  else, so they are advisory. Put the same rules in your `AGENTS.md`.
- `install.sh` creates a skills directory for Claude Code and Codex, since both are
  known to read one. For any other tool it links only into a skills directory that
  already exists, so it never invents a path a tool may ignore. Override with
  `SEED_DIRS` and `EXTRA_DIRS`.

`AGENTS.md` is the right home for the rules themselves. It is the one file every tool
reads, so a rule written there applies everywhere, and the hooks in Claude Code just
make a subset of it mechanical.

## The Loop

```
/plans new [hint]             survey, ask where it lands, write the batch it finds
/plans                        the frontier: what is open and unblocked
/plans do 001                 branch, probe, route to a playbook, verify, hand back
                              you review, commit, open the PR
/plans review 001             paste the review, fix each, draft the replies
/plans close 001              file it
```

Nothing in here stages, commits, pushes or posts. Work lands unstaged on a `feat/*`
branch and you take it from there.

## Plans

A plan carries **intent and acceptance criteria**. It never carries a snapshot of
current code, because snapshots rot. Where a plan would have quoted `file.ts:16-23`, it
carries a `## Probe` block instead: ripgrep queries over symbols, run at execution time.

```markdown
## Outcome

One paragraph. What is true when this is done.

## Acceptance

- [ ] Blocking a user removes their messages from search, pins and reply previews.

## Probe

rg -n "blockedUserIds|isBlocked" src/
```

The probe has three outcomes, all safe: already true (mark done, stop), unmet
(continue), or nothing recognizable (the subsystem moved, stop and report). That last
one is the only stop condition, and it fires on the subsystem having moved, never on a
file having changed. That is what lets sibling plans in one batch survive each
other landing.

Everything a batch shares lives in one `ctx-<batch>.md` that the siblings reference by
name. When the shared picture changes you edit one file.

Plans live in the plans directory, `~/Plans` by default, `PLANS_DIR` to move it.
Projects are whatever directories exist in there, discovered at runtime.

```
$PLANS_DIR/
  log.tsv                        append-only trail, all projects
  <Project>/
    index.tsv                    status only, note capped at 100 chars
    NNN-slug.md                  open plans, 4 KB cap
    ctx-<batch>.md               shared context, referenced never copied
    done/NNN-slug.md             closed, carries ## Landed
```

## Playbook

`/playbook` matches a task to one of ten playbooks and copies its steps into the todo
list verbatim. Bug fix, feature, refactoring, perf, investigation, prototype, babysit,
session pickup, pause safely, authoring a skill. Plus `backlog-item`, which is what
`/plans do` runs, and `handing-back`, which every playbook ends with.

Before anything else it reads the principles index. The twenty one principles are
standalone `principle-<slug>` skills, slash addressable, each read in full before it is
applied. The playbook indexes them and names the trigger for each. They carry
`disable-model-invocation: true`, so they never enter the model's skill listing and
cost nothing per session.

**The destination gate runs first, before the probe.** If a plan does not name exactly
one surface, or public versus private is inferable from more than one place, it stops
and asks. This overrides the never-block-on-the-human principle by name, because the
incident it exists for happened while implementing a plan, not while writing one: a tab
name read as the public profile while a private directory of the same name existed, and
a private breakdown shipped to a public page.

## Models

gpt-5.6 is not available as a subagent model, so every gpt-5.6 role goes through a
wrapper in `agents/` that shells out to the Codex CLI.

| role                                   | agent            |
| -------------------------------------- | ---------------- |
| judgment, taste, prose, vague intent   | `fable-max`      |
| second Claude arm on a panel           | `opus-xhigh`     |
| hard unsupervised reasoning            | `codex-sol`      |
| everyday implementation                | `codex-terra`    |
| simple mechanical work                 | `codex-luna`     |
| independent review of the working tree | `codex-reviewer` |

`codex-reviewer` runs `codex review --uncommitted`, the only mode that sees staged,
unstaged and untracked changes together.

Pick the tier deliberately per task. Never quietly drop to the cheapest tier for work
that needs judgment.

## Hooks

Two, both exiting immediately when `AGENT_HOOKS=0` is set.

- `session-brief.sh` on `SessionStart`. Injects the branch, dirty counts, the matching
  plan row and the recent trail. This is what survives a cleared context.
  Silent outside a git repo, or when there is no plans directory.
- `no-em-dash.sh` on `PostToolUse` for Write and Edit. Blocks em and en dashes in
  authored files, skipping fenced code, inline code and URLs.

Pair them with `permissions.deny` for `EnterWorktree`, `git commit`, `git push`,
`gh pr create`, `gh pr comment`, and any package manager your lockfile does not
sanction. A deny rule is an exact prefix match on a tool call, so it does not misfire
the way a hook grepping the command string does. A rule in prose is a suggestion. A rule
in settings is a rule.

## Configuration

| variable           | default                     | what it does                                          |
| ------------------ | --------------------------- | ----------------------------------------------------- |
| `PLANS_DIR`        | `~/Plans`                   | where plans and the trail live                        |
| `AGENT_HOOKS`      | `1`                         | set to `0` to disable every hook                      |
| `AGENT_HOOKS_SKIP` | vendored and generated dirs | comma separated path fragments the dash guard ignores |
| `AGENTS_DIR`       | `~/.agents/skills`          | where `install.sh` links skills                       |
| `CLAUDE_HOME`      | `~/.claude`                 | where `install.sh` copies agents and hooks            |

## License

MIT, including the [pstack](https://github.com/cursor/plugins) and [Matt Pocock](https://github.com/mattpocock/skills) portions. See [LICENSE](./LICENSE).

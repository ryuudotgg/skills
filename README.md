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

Skills only, into every agent tool it detects:

```bash
npx skills@latest add ryuudotgg/skills -g
```

This does not install `agents/` or `hooks/`, because neither is a skill. Without the
agents the panel skills (`interrogate`, `how`, `architect`) run their Codex arms only,
or a single pass when `codex` is not on PATH either, which they handle, and without
the hooks there is no session brief.

Everything, including the agents and hooks:

```bash
git clone https://github.com/ryuudotgg/skills && cd skills && ./install.sh
```

`install.sh` symlinks `skills/` into the canonical store at `~/.agents/skills`, links
them into every agent tool it finds, copies `agents/` and `hooks/` into `~/.claude`, and
writes `~/.codex/hooks.json` pointing Codex at the same hook scripts. Safe to re-run.
The hooks still need wiring in `~/.claude/settings.json`, and Codex needs a one-time
`/hooks` trust. See [hooks](#hooks).

A plain install is hands-off, with no optional skill linked. `./install.sh --with prs`
switches the delivery mode to prs, as `skills/playbook/references/delivery.md` defines
it, and `--with <skill>` links an optional skill. `--without <name>` turns either off.
The choice is saved to `~/.agents/skills.conf` and kept on reruns. With Claude Code
present, each run prints the `permissions.deny` set for the mode. Paste it into
`settings.json` yourself, since the installer never edits that file.

## What Runs Where

`skills/` is plain markdown plus a few POSIX shell scripts. Nothing in it is tied to
one agent, so it works anywhere skills are read. `agents/` is a Claude Code format and
only loads there. `hooks/` speak the hook protocol Claude Code and Codex share.

|                            | Claude Code | Codex | Cursor, Copilot, OpenCode           |
| -------------------------- | ----------- | ----- | ----------------------------------- |
| `skills/`                  | yes         | yes   | yes, if the tool reads a skills dir |
| `plans` and its scripts    | yes         | yes   | yes                                 |
| `agents/` Claude subagents | yes         | no    | no                                  |
| `hooks/`                   | yes         | yes   | no                                  |
| `permissions.deny`         | yes         | no    | no                                  |

What that means in practice outside Claude Code:

- The panel skills (`interrogate`, `how`, `architect`) fan out to the Claude agents
  in `agents/` and to Codex arms, which are plain calls to the Codex CLI. With neither,
  the panel degrades to a single pass rather than failing, which each skill states
  in its own steps.
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

The Codex models (gpt-6-astra and the gpt-5.6 tiers) are not available as subagent
models. A Codex role is a Codex arm: one background Bash call to the Codex CLI that the
lead runs itself and reads back from a file. The playbook skill's **Codex arms** section
points at its `references/codex-arms.md`, which holds the tier table with the reasoning
effort pinned per tier, the one invocation, and the rules every prompt restates.
`agents/` holds the Claude agents only.

| role                                   | arm                  |
| -------------------------------------- | -------------------- |
| judgment, taste, prose, vague intent   | `fable-judgment`     |
| second Claude arm on a panel           | `opus-review`        |
| hardest unsupervised reasoning         | astra arm            |
| complex work below the top tier        | sol arm              |
| everyday implementation                | terra arm            |
| simple mechanical work                 | luna arm             |
| independent review of the working tree | the Codex review arm |

The review arm runs the `review` subcommand with `--uncommitted`, the only mode that
sees staged, unstaged and untracked changes together.

Pick the tier deliberately per task. Never quietly drop to the cheapest tier for work
that needs judgment.

## Hooks

Four, all exiting immediately when `AGENT_HOOKS=0` is set. Claude Code and Codex run
the same scripts: the stdin payloads and the block JSON match for these events, and the
scripts read Codex's `apply_patch` command where Claude Code sends `content` or
`new_string`.

- `session-brief.sh` on `SessionStart`. Injects the branch, dirty counts, the matching
  plan row and the recent trail. This is what survives a cleared context.
  Silent outside a git repo, or when there is no plans directory.
- `no-em-dash.sh` on `PostToolUse` for Write, Edit and MultiEdit. Blocks em and en dashes in
  authored files, skipping fenced code, inline code and URLs.
- `no-comments.sh` on `PostToolUse` for Write, Edit and MultiEdit. Lists every full-line
  comment the call added to a code file (`new_string` minus `old_string` for Edit, or the
  file re-read from disk and diffed against git HEAD for Write and MultiEdit) and blocks
  with the rule: default none, keep one line only for
  an external constraint, a landmine, or why the obvious approach lost. Shebangs, lint
  and type pragmas, license headers, prose files and vendored dirs pass. A comment you
  keep is flagged once, when it is written, and never again.
- `reply-guard.sh` on `Stop`. Reads the final reply from `last_assistant_message` and
  blocks on the tells a regex can catch: em, en or hyphen dashes outside code, chatbot
  filler ("Let me know if", "It's worth noting"), and a bold label followed by a colon.
  It also diffs the tree against `HEAD` plus untracked files and lists added comment
  lines, which is what catches a Codex delegate's edits, since those never pass through
  a Write or Edit tool. Each line is reported once per session (state in
  `scratchpad_dir`), and `stop_hook_active` ends the loop.

`hooks/comment_scan.py` is the detector both comment hooks share: a per-extension
marker table with block-comment state, so a JSDoc body counts line by line. It knows
full-line comments only. A trailing `// note` after code passes, as does a marker inside
a string. Semantic judgment (is this line a why the code cannot show) stays with
`/no-comments` and `comment-sicko`.

```json
"PostToolUse": [{ "matcher": "^(Edit|MultiEdit|Write)$", "hooks": [
  { "type": "command", "command": "~/.claude/hooks/no-em-dash.sh" },
  { "type": "command", "command": "~/.claude/hooks/no-comments.sh" } ] }],
"Stop": [{ "hooks": [ { "type": "command", "command": "~/.claude/hooks/reply-guard.sh" } ] }]
```

For Codex, `install.sh` writes the equivalent `~/.codex/hooks.json` with absolute paths.
Codex refuses to run a hook until its exact definition is trusted, and trust is recorded
against the file's hash, so open `codex`, run `/hooks`, and trust them once. Re-running
`install.sh` rewrites the file byte for byte, so trust survives a reinstall until a hook's
command line changes. `AGENT_HOOKS=0` disables them the same way.

Pair them with `permissions.deny` for `EnterWorktree`, `git commit`, `git push`,
`gh pr create`, `gh pr comment`, and any package manager your lockfile does not
sanction. A deny rule is an exact prefix match on a tool call, so it does not misfire
the way a hook grepping the command string does. A rule in prose is a suggestion. A rule
in settings is a rule.

## Checks

```bash
python3 scripts/validate.py       # frontmatter, paths, agent names, dashes, codex flags
python3 -B hooks/test_hooks.py    # the comment and reply hooks against sample payloads
sh scripts/test-install.sh         # installer modes, links, config and deny sets
sh skills/plans/scripts/test-lint.sh          # the plans lint against a fixture plans directory
evals/run.sh <case> [--grade]     # run one skill against a fixture repo, see evals/README.md
python3 scripts/audit-sessions.py --days 14   # where task time went, from local stores
```

The validator is what the authoring playbook runs before handing a skill back. The evals
are one case per known failure mode; each one settles by running whether a sentence in a
skill changes behaviour.

`scripts/audit-sessions.py` is the measurement the throughput work is judged against,
not a check. It reads the plans trail, this project's Claude session store and the Codex
rollouts, all read only, and prints task durations by plan effort, the phase split of
each `/plans do` window, and both subagents and Codex runs grouped by model and
reasoning effort. Pass `--json` for the same numbers as one object, so two runs can be
diffed, and `--project-dir` to read a different project's store.

## Configuration

| variable           | default                     | what it does                                         |
| ------------------ | --------------------------- | ---------------------------------------------------- |
| `PLANS_DIR`        | `~/Plans`                   | where plans and the trail live                       |
| `AGENT_HOOKS`      | `1`                         | set to `0` to disable every hook                     |
| `AGENT_HOOKS_SKIP` | vendored and generated dirs | comma separated path fragments the file hooks ignore |
| `AGENTS_DIR`       | `~/.agents/skills`          | where `install.sh` links skills                      |
| `CLAUDE_HOME`      | `~/.claude`                 | where `install.sh` copies agents and hooks           |
| `CODEX_HOME`       | `~/.codex`                  | where `install.sh` writes the Codex `hooks.json`     |
| `SKILLS_CONF`      | `~/.agents/skills.conf`     | installer delivery mode and optional skills          |

## License

MIT, including the [pstack](https://github.com/cursor/plugins), [Matt Pocock](https://github.com/mattpocock/skills), [Emil Kowalski](https://github.com/emilkowalski/skills) portions. The UI design reference also condenses guidance from [Impeccable](https://github.com/pbakaus/impeccable), Apache 2.0. See [LICENSE](./LICENSE).

---
name: plans
description: "Durable backlog on disk. Bare /plans prints the ready frontier, /plans new surveys and writes a batch, /plans do starts one on a branch, /plans wave runs the close sweep then starts every ready one in its own thread, /plans close archives it, or with no id closes each merged one whose thread has finished. Project detected from the working directory. Publishing follows the delivery mode."
disable-model-invocation: true
---

# Plans

The backlog the operator addresses by name across sessions. The plans directory is the continuity, the transcript is not.

Every path below lives under the plans directory: `${PLANS_DIR:-$HOME/Plans}`, written as `<plans>` from here on. Default `~/Plans`, override with `PLANS_DIR`.

## Rules that override everything below

- Who stages, commits, pushes and posts is stated once, in the playbook skill's `references/delivery.md`. The `/plans do` ending and `/plans review` below follow the mode. Outside those two verbs this skill only reads code, writes files under `<plans>`, creates local branches, records each one's base in git config, and fetches the remote default branch, except that the sweep, which `/plans close` with no id and `/plans wave` both run, also removes the scratch and the checkouts its helpers free.
- No worktrees, ever. Scratch space is `/tmp/plans-<id>/`. Never pass an isolation parameter to any tool, in any form: `isolation: "remote"` silently downgrades to a worktree. The one exception is the checkout `t3_thread_launch` creates for a thread `/plans wave` starts: the harness makes and binds it before the thread runs, no agent runs git to make it, and the plan thread working in it keeps this rule.
- Ambiguity about where something lands (which surface, which tab, public or private, who can see it) is a blocking question. It is never a default, never inferred from the nearest plausible directory, never settled by a prototype. This is the named override of the never block on the human principle: on destination, you block.
- Writes to production data need an approved plan first. That covers any script handed to the operator to run against prod, and any MCP tool that mutates production state (bans, deletions, merges, bulk notifications, access grants). Read only queries and searches do not.
- Never kill, restart or hijack a process, server or database you did not start in this session. If one is in the way, say so and ask. The one exception is `skills reap`, which stops and deletes the simulators, emulators, containers and servers whose owner it reads as a closed plan, a handed back ad hoc branch, or with `--mine` the task handing back, never one with no owner.
- Detect the package manager from the lockfile and use it. Never introduce a competing lockfile.
- Choose the model tier deliberately per task. Never silently downgrade to the cheapest tier for work that needs judgment.
- Nothing written here carries a code comment, an em dash, an en dash, a hyphen used as a dash, or AI sounding copy. Use commas, colons, parentheses or a full stop.

## Project detection

Projects are the directories under `<plans>`, discovered at runtime. There is no known list.

Match the git toplevel basename against those directory names case insensitively. If it does not match, try the main checkout's name from git's common directory, so a linked worktree resolves even when its folder has another name. Outside a repo, use the basename of `$PWD` as the only candidate. The first match wins, using the directory's own casing. No match means ask which project. Never guess, and never create a new project directory without being told to. The CLI keeps this rule. `plans frontier` with no argument detects through it, and `plans handoff`, `plans stack-base` and `plans below` refuse when run from a checkout of another project. The session start hook uses the same TypeScript code.

## Layout

```
<plans>/plans.db                      the store: every row change and trail event, one SQLite file per machine
<plans>/log.tsv                       view of the global append only trail, written by the store
<plans>/<Project>/index.tsv           view of status only, tab separated, note capped at 100 chars
<plans>/<Project>/NNN-slug.md         open plans, intent only, 4 KB cap above ## Landed
<plans>/<Project>/ctx-<batch>.md      shared model for a batch, referenced never copied
<plans>/<Project>/done/NNN-slug.md    closed plans, each carrying a ## Landed section
<plans>/<Project>/_archive/README.md  an older prose index, never read by an agent
<plans>/audit/<repo>/YYYY-MM-DD.json  one saved `skills audit --digest` run per repository and UTC date
```

`index.tsv` and `log.tsv` are views: the store rewrites them after every write, byte for byte what they held before the store existed, so reading them works as it always has. Never edit either by hand. A write that finds a view changed outside the store refuses, naming the file and `skills plans import`, which takes the edit into the store.

The backlog verbs and the two stack helpers run through the CLI at `<playbook>/bin/skills`. `<skill>` is the absolute path of the directory this file was loaded from, and `<playbook>` is the playbook skill's directory beside it. Run every helper from the project's checkout by that absolute path. Never `cd` into `<skill>`: it sits inside the skills repository, so a helper started there reads that repository's git state and cuts its branches there.

```
<playbook>/bin/skills plans frontier [--next | --stacks-on <id>] [--at <time>] [Project]
<playbook>/bin/skills plans set-row <Project> <id> <STATUS> [branch|-] [note|-]
<playbook>/bin/skills plans add <Project> <slug> <pri> <effort> [blocked_by|-] [ctx|-] [note|-] [--resolves <Project>#<n>]
<playbook>/bin/skills issues list [Project] [--all]
<playbook>/bin/skills issues file <Target> <title> [--body <file>] [--from <Project>/<id>] [--blocks <Project>/<id>]
<playbook>/bin/skills plans log <Project> <id> <event> [detail]
<playbook>/bin/skills plans import
<playbook>/bin/skills plans show <Project> <id | ctx-slug> [--at <time>] | --conflict <Project> <id | ctx-slug>
<playbook>/bin/skills plans history <Project> <id | ctx-slug>
<playbook>/bin/skills plans checkout <Project> <id | ctx-slug>
<playbook>/bin/skills plans lint <Project> [id | --overlap]
<playbook>/bin/skills plans chain <branch>
<playbook>/bin/skills plans handoff <Project> <id>
<playbook>/bin/skills plans start <Project> <id | ctx-slug>
<playbook>/bin/skills plans close [--dry-run] <Project> <id> <DONE|DROPPED> <note> [--sha <sha>]
<playbook>/bin/skills plans pin <Project> <id>... [--for <duration>]
<playbook>/bin/skills plans move <Project> <id> [--to <label | device id> | --file <path>]
<playbook>/bin/skills plans adopt <Project> <id> [--file <path>]
<playbook>/bin/skills machine show [--json]
<playbook>/bin/skills machine label <name>
<playbook>/bin/skills machine refresh [--environment <id>]
<playbook>/bin/skills plans sweep <Project> [--dry-run] [--json]
<playbook>/bin/skills plans release <Project> [--dry-run] [--facts]
<playbook>/bin/skills reap (<Project> | --mine) [--dry-run]
<playbook>/bin/skills device ios|android [--type <type>]
<playbook>/bin/skills plans stack-base [--cut] <Project> <id>
<playbook>/bin/skills plans below <Project> <base>
<playbook>/bin/skills plans wave <Project> [--dry-run]
<playbook>/bin/skills plans resume <Project> [--facts]
<playbook>/bin/skills plans schedule [Project]
<playbook>/bin/skills threads resume [--facts]
```

Helper detail, what each CLI verb above reads, writes and refuses, is in `references/verbs.md`; read it when a verb's output or refusal needs that detail. The rules an agent acts on:

- Rows and trail lines change only through the CLI: `plans set-row`, `plans add`, `plans start`, `plans adopt`, `plans close` and `plans sweep` write rows and their trail lines, `plans log` and `threads log` append trail lines, and `skills issues file --blocks` and an issue's close change the rows that issue blocks.
- A view edited outside the store makes `plans sweep`, `plans release` and `skills reap` refuse too, naming `skills plans import`.
- `plans move` and `plans adopt` never run unasked: `plans move` only from the Pause safely playbook when the operator named a target, `plans adopt` only when the operator asks for it.
- `plans release` is the only verb that removes a checkout. Run no `git worktree remove`, `git worktree prune` or `rm` on one yourself.

With a hub configured and the store enrolled, `plans start` first takes the plan's hub lease, so one plan runs on one machine at a time. Another device's lease refuses before anything changes, with `held by <label> since <time>`. With the hub unreachable it records a provisional lease, prints `lease provisional, hub offline` on stderr, and the next sync offers it; a refused offer flags the plan `conflict with <label>` in both frontiers until the operator runs `skills plans lease break <Project> <id>`, the one verb that ends another device's lease and the one the agent never runs unasked. `plans pin` takes or extends a lease without starting the plan, for a number of hours or days up to `30d` (default `7d`). A `handback` log line, `plans close` and a row set DROPPED release the lease, and the frontier marks a DOING row leased elsewhere `on <label>` and a ready row pinned elsewhere `pinned by <label>`. Without a hub none of this runs.

## index.tsv schema

Header row, tab separated, exactly these ten columns:

```
id	slug	status	pri	effort	blocked_by	ctx	branch	updated	note
```

| column       | value                                                             |
| ------------ | ----------------------------------------------------------------- |
| id           | three digits, zero padded, never reused                           |
| slug         | kebab case, matches the plan filename                             |
| status       | TODO, DOING, DONE, DROPPED, BLOCKED, REVIEW                       |
| pri          | P0, P1, P2, P3                                                    |
| effort       | XS, S, M, L                                                       |
| blocked_by   | `-`, or a comma separated list of the forms below                 |
| `093`        | row 093 of this project                                           |
| `Stanza/168` | row 168 of project Stanza, a plan ref                             |
| `Stanza#3`   | issue 3 in Stanza's inbox, an issue ref from `skills issues file` |
| ctx          | batch slug such as `ctx-chat-scale`, or `-`                       |
| branch       | `feat/<slug>`, or `-` until started                               |
| updated      | YYYY-MM-DD                                                        |
| note         | one line, hard cap 100 chars, no tabs                             |

The note is a label, not a story. Every narrative (what shipped, why it was dropped, what deviated) lives in the plan file. Uncapped notes are what grow an index to hundreds of kilobytes and make the frontier unreadable.

REVIEW means the plan's PR is open. In the index it still blocks dependent plans, and only DONE or DROPPED, in the blocker's own project for a plan ref, or a closed issue, releases a blocker. A plan ref never becomes a stack base, and an issue ref is no branch at all. `/plans do` also asks `gh`, so a REVIEW row whose PR already merged releases its dependents there.

## Plan file template

Exact shape. Intent only, 4 KB hard cap, at most three acceptance criteria.

```markdown
---
id: 095
slug: bound-room-fanout
project: <Project>
ctx: ctx-chat-scale
pri: P1
effort: S
blocked_by: 093
surface: chat gateway, server side only, no user visible change
critical: false
needs: node
created: 2026-08-31
---

# 095 bound-room-fanout

## Outcome

What is true when this is done, as behaviour on exactly one named destination
surface. No current code state, no file:line, no steps.

## Acceptance

1. A claim someone else can check, with the command that checks it.
2. A second, independently verifiable claim.
3. A third at most. A fourth means this plan splits.

## Probe

Ripgrep over symbols, run at execution time to re-derive state.

    rg -n "broadcastToRoom|roomSubscribers" src/chat

a. Symbols present and the behaviour already correct: close as DROPPED.
b. Symbols present, behaviour missing: proceed.
c. No hits, renamed or deleted: stop and re-derive intent with the operator
before writing any code.

## Constraints

What would make a correct looking implementation wrong. Reference ctx-chat-scale
by name for the shared model, do not restate it.

## Notes

Anything that is not intent. Optional, usually empty.
```

`needs:` is the one optional frontmatter line. It names what a machine must have to run the plan, comma separated words of the capability set `macos`, `linux`, `xcode`, `android`, `docker` and `node`; leave it out when any machine with a checkout of the project can.

The ctx file holds the shared picture for the batch: the subsystem model, the vocabulary, the invariants, the surfaces in play, the measurements already taken. Siblings reference it by name. Nothing is copied out of it. When the picture changes one file gets edited instead of fifteen, which is the structural fix for intra batch drift.

Ctx file shape. The sections above `## Prior work` are the usual ones, add or drop them as the batch needs. `## Prior work` and `## Verify` are fixed and always last, in that order.

```markdown
# ctx-chat-scale

## Invariant

The one claim every plan in the batch protects, stated so a sibling can check it.

## Vocabulary

The batch's terms, each defined once here and nowhere else.

## Surfaces in play

Every file, route, package or worker the batch touches, public or private named.

## Prior work

One line per DONE or DROPPED plan the /plans new searches found that bears on
the batch, as `<Project>/<id> <slug> (<status>): <one clause>`, the clause
saying what it landed or why it was dropped, or the single line `None found.`.

## Verify

A script path under the repo that serves, drives and asserts the surface, or the
words "none, unit tests cover it". The first plan that needs the harness builds
it and every later plan runs it, so name what it must prove and where it lives,
never its contents.
```

## The landed draft

The plan's own thread appends its `## Landed` section when it hands back, in either delivery mode, before any merge exists. This shape, with the plan's branch on the first line:

```markdown
## Landed

Branch feat/bound-room-fanout, not merged yet.
What actually shipped, in two or three sentences.
Deviations from the Outcome and why the deviation was right.
What was deliberately left, with the id it became if it became one.
```

Every later handback on the plan, each fix round included, rewrites the lines under the first so the draft says what the branch ships now. The 4 KB cap counts only the text above `## Landed`, so the draft never fails lint. `/plans close` rewrites the first line to `Merged as <short sha> (PR <number>, branch <branch>).` and leaves every other byte alone.

## /plans

Bare. Prints the frontier and nothing else.

1. Detect the project.
2. Run `<playbook>/bin/skills plans frontier <Project>`. It selects status TODO, resolves `blocked_by` against the other rows, and prints ready rows sorted by priority, then blocked rows with what they wait on, rows set BLOCKED with their branch and note, REVIEW rows, then anything DOING. A ready row whose only open blockers are REVIEW rows on one chain shows `stacks on <id> (<branch>)`. Rows held by REVIEW rows on two chains show under blocked with `two stacks`. A ready row whose plan carries `needs:` ends with `  needs <cap>,<cap>`, and `--next` skips a row this machine does not meet; with `--at` needs are ignored. A DOING row whose newest `heartbeat` or `start` event is over 30 minutes old ends with `(<label>, stale <n> min)`, and the session brief's `Plan <id>` line gains the same; the post tool use and stop hooks write a heartbeat for the DOING row on the current branch at most every 5 minutes per session.
3. Print the table.

Read zero plan bodies. Do not `ls` the plan files, do not open `ctx-*.md`, do not open `done/`, do not read `_archive/`. Budget is under 2k tokens. A body gets read only when the operator names an id.

## Verbs

Each verb's text lives under `references/`. Read the files or steps its line names in full before running the verb, and again once they have left your context. Bare `/plans` reads none of them. Where this skill or a reference says above or below, it may mean a section of another file; wherever this skill, a reference or a playbook names another verb's step, read that step in its file.

- `/plans new [scope hint]`: `references/new.md`, and `plans add` in `references/verbs.md` for how a new plan's id is taken.
- `/plans do [id]` and `/plans do <ctx-slug>`: `references/do.md`. A babysit that hits a stale layer reads step 1 of `references/review.md`.
- `/plans wave`: `references/wave.md`, and the sweep in `references/close-and-sweep.md`, which it runs first.
- `/plans close [id]` and the sweep: `references/close-and-sweep.md`.
- `/plans review <id>`: `references/review.md`, and step b of `references/do.md` for binding the thread.
- `/plans resume`, `/plans threads resume` and `/plans schedule`: `references/resume-threads-schedule.md`.

## Running a batch

A batch from TODO rows to closed plans, in prs mode. Hands-off mode keeps the same order, with every publishing step left to the operator as the playbook skill's `references/delivery.md` states.

1. `/plans` prints the frontier. A ready row is one thread, and one thread runs at a time per checkout, since its row stays DOING while it works.
2. `/plans wave` runs the sweep, then starts one fresh thread per ready row that overlaps no other, or `/plans do <id>` in a fresh thread starts one. Either way the plan's thread cuts the plan's branch from the trunk, or from the REVIEW layer it stacks on once no open layer below holds an unresolved thread a reviewer started, implements it, and opens its PR or stack layer. `/plans do <ctx-slug>` instead takes every ready XS and S row of one ctx into one thread and one PR.
3. The same thread then babysits the layer's whole stack in `drive` mode, bottom first, until every layer reaches the handoff state, the reviewer round included. Its rows go to REVIEW when it stops. Only then does the reply name the ready plans that stack on the layer, each to start in a new thread.
4. A review that lands outside a babysit gets `/plans review <id>`: one fix round on the owning branch, with every owned layer above lease rebased onto it.
5. The operator merges, bottom first. Nothing in this skill merges. A merged blocker releases its dependents at the next `/plans do`, even while its row still reads REVIEW.
6. `/plans close <id>` for each merged plan stamps its landed draft with the merge and sets the row DONE. `/plans close` with no id does it at once for each merged plan whose thread has finished, and clears the scratch, threads and checkouts nothing else still holds. Every `/plans wave` runs that same sweep first.

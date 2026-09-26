---
name: plans
description: "Durable backlog on disk. Bare /plans prints the ready frontier, /plans new surveys and writes a batch, /plans do starts one on a branch, /plans close archives it. Project detected from the working directory. Never commits, never posts."
disable-model-invocation: true
---

# Plans

The backlog the operator addresses by name across sessions. The plans directory is the continuity, the transcript is not.

Every path below lives under the plans directory: `${PLANS_DIR:-$HOME/Plans}`, written as `<plans>` from here on. Default `~/Plans`, override with `PLANS_DIR`.

## Rules that override everything below

- Never commit. Never stage. Never push. Never post to a remote: no `gh pr create`, no PR, issue or review comments, no replies, no merges. The operator commits and posts everything. This skill only reads code, writes files under `<plans>`, and creates local branches.
- No worktrees, ever. Scratch space is `/tmp/plans-<id>/`. Never pass an isolation parameter to any tool, in any form: `isolation: "remote"` silently downgrades to a worktree.
- Work lands unstaged on a `feat/*` branch in the main tree.
- Ambiguity about where something lands (which surface, which tab, public or private, who can see it) is a blocking question. It is never a default, never inferred from the nearest plausible directory, never settled by a prototype. This is the named override of the never block on the human principle: on destination, you block.
- Writes to production data need an approved plan first. That covers any script handed to the operator to run against prod, and any MCP tool that mutates production state (bans, deletions, merges, bulk notifications, access grants). Read only queries and searches do not.
- Never kill, restart or hijack a process, server or database you did not start in this session. If one is in the way, say so and ask.
- Detect the package manager from the lockfile and use it. Never introduce a competing lockfile.
- Choose the model tier deliberately per task. Never silently downgrade to the cheapest tier for work that needs judgment.
- Nothing written here carries a code comment, an em dash, an en dash, a hyphen used as a dash, or AI sounding copy. Use commas, colons, parentheses or a full stop.

## Project detection

Projects are the directories under `<plans>`, discovered at runtime. There is no known list.

Take `basename` of the git toplevel, or of `$PWD` outside a repo, and match it case insensitively against those directory names. Use the directory's own casing from then on. No match means ask which project. Never guess, and never create a new project directory without being told to. `scripts/frontier.sh` does exactly this when called with no argument.

## Layout

```
<plans>/log.tsv                       global append only trail
<plans>/<Project>/index.tsv           status only, tab separated, note capped at 100 chars
<plans>/<Project>/NNN-slug.md         open plans, intent only, hard cap 4 KB
<plans>/<Project>/ctx-<batch>.md      shared model for a batch, referenced never copied
<plans>/<Project>/done/NNN-slug.md    closed plans, each carrying a ## Landed section
<plans>/<Project>/_archive/README.md  an older prose index, never read by an agent
```

Helper scripts, paths relative to this skill's own directory, all local, none of them touch git or a remote:

```
sh scripts/frontier.sh [Project]
sh scripts/set-row.sh <Project> <id> <STATUS> [branch|-] [note|-]
sh scripts/log.sh <Project> <id> <event> [detail]
sh scripts/lint.sh <Project> [id]
```

All four resolve `${PLANS_DIR:-$HOME/Plans}` themselves. `set-row.sh` stamps `updated` and truncates the note to 100 chars. `log.sh` creates `log.tsv` with its header on first use.

## index.tsv schema

Header row, tab separated, exactly these ten columns:

```
id	slug	status	pri	effort	blocked_by	ctx	branch	updated	note
```

| column     | value                                       |
| ---------- | ------------------------------------------- |
| id         | three digits, zero padded, never reused     |
| slug       | kebab case, matches the plan filename       |
| status     | TODO, DOING, DONE, DROPPED, BLOCKED         |
| pri        | P0, P1, P2, P3                              |
| effort     | XS, S, M, L                                 |
| blocked_by | comma separated ids, or `-`                 |
| ctx        | batch slug such as `ctx-chat-scale`, or `-` |
| branch     | `feat/<slug>`, or `-` until started         |
| updated    | YYYY-MM-DD                                  |
| note       | one line, hard cap 100 chars, no tabs       |

The note is a label, not a story. Every narrative (what shipped, why it was dropped, what deviated) lives in the plan file. Uncapped notes are what grow an index to hundreds of kilobytes and make the frontier unreadable.

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

The ctx file holds the shared picture for the batch: the subsystem model, the vocabulary, the invariants, the surfaces in play, the measurements already taken. Siblings reference it by name. Nothing is copied out of it. When the picture changes one file gets edited instead of fifteen, which is the structural fix for intra batch drift.

Ctx file shape. The sections above `## Verify` are the usual ones, add or drop them as the batch needs. `## Verify` is fixed and always last.

```markdown
# ctx-chat-scale

## Invariant

The one claim every plan in the batch protects, stated so a sibling can check it.

## Vocabulary

The batch's terms, each defined once here and nowhere else.

## Surfaces in play

Every file, route, package or worker the batch touches, public or private named.

## Verify

A script path under the repo that serves, drives and asserts the surface, or the
words "none, unit tests cover it". The first plan that needs the harness builds
it and every later plan runs it, so name what it must prove and where it lives,
never its contents.
```

## /plans

Bare. Prints the frontier and nothing else.

1. Detect the project.
2. Run `sh scripts/frontier.sh <Project>`. It selects status TODO, resolves `blocked_by` against the other rows, and prints ready rows sorted by priority, then blocked rows with what they wait on, then anything DOING.
3. Print the table.

Read zero plan bodies. Do not `ls` the plan files, do not open `ctx-*.md`, do not open `done/`, do not read `_archive/`. Budget is under 2k tokens. A body gets read only when the operator names an id.

## /plans new `[scope hint]`

Survey and write plans. Read only on source code. This verb never implements, never edits code, never branches.

The hint is optional and free text: a subsystem, a symptom, a goal, a pasted error. `/plans new` on its own surveys the whole project. Nothing else is an argument, because everything else is discoverable and the caller has not read the code yet.

- **The project is detected**, per Project detection above. Never ask for it when the working directory answers it.
- **The batch slug is derived** from what the survey actually found, not from what anyone guessed before looking. Name it after the subsystem or the invariant the batch shares.
- **The plan count falls out of the sizing rule in step c.** It is a result, never an input. A caller who asks for five plans is guessing at an answer the survey has not produced yet.

Bootstrap if needed: create `<plans>/<Project>/` and `done/`, create `index.tsv` with the header row, and if a prose `README.md` sits at the project root move it to `_archive/README.md`.

**a. Survey first, then ask the one question you cannot answer.** Never ask what you can read. The survey decides the batch boundary, the slug and the count. The one thing it cannot decide is destination: use `AskUserQuestion` naming the candidate surfaces you actually found (the specific tab, route, panel, package or worker, and whether it is public or private). Refuse to infer. This is the named override of never block on the human, and it is the only blocking question this verb has. A tab name that reads as the public profile, while a private directory of the same name sits next to it, is how a user's private breakdown ships to a public page. Refuse to write any plan whose `## Outcome` does not name exactly one destination surface.

If the survey finds work spanning more than one unrelated subsystem, do not silently merge it into one batch and do not demand the operator pick up front. Propose the split you found, one line per batch, and write the one they confirm.

**b. Write the batch.** One plan per unit plus exactly one `ctx-<batch-slug>.md`. Everything the siblings would otherwise each restate goes in the ctx file once. A sibling that repeats two paragraphs of the ctx file is a defect, cut it and reference the name. A plan that touches auth, billing, data or migrations gets `critical: true`. Any other plan carries `critical: false` or leaves the line out, since absent means false.

**c. Unit sizing is a hard rule, and it is what sets the count.** At most three acceptance criteria and at most 4 KB per plan. A unit that needs more splits into two ids, so the count is whatever the work divides into under that cap. Check it with `sh scripts/lint.sh <Project>`, which fails a plan with no `surface:` value, with a `critical:` value other than `true` or `false`, over 4 KB, with more than three acceptance items, or carrying a banned section. On a ctx file it also fails a line pointing forward at an id the index records as closed, and a line recording an intention with no id behind it. It runs before the step d row append, so a plan that fails never reaches `index.tsv`.

**d. Append one row per plan to `index.tsv`,** ids continuing from the highest existing id, status TODO, branch `-`.

**e. One adversarial validation pass** over the written batch plus the ctx file. Delegate it to an independent reviewer on a high reasoning tier, or run it directly:

An astra arm at high effort per the playbook skill's **Codex arms** section, `-s read-only --skip-git-repo-check`, slug `plans-<batch-slug>`, with `-C` pointed at `${PLANS_DIR:-$HOME/Plans}/<Project>`. The flag stays because that directory is neither a git repository nor a Codex trusted project, and the read only sandbox makes skipping the check safe. The prompt:

```
Read ctx-<batch-slug>.md and every plan file in this batch.
For each plan: is every acceptance criterion independently verifiable by a
person with only this file, or does it rely on knowledge that is not written
down? Name the criteria that fail.
Across the batch: does any plan restate another plan, or restate the ctx file?
Name the duplicated pairs and which one should own the content.
Also flag any plan whose Outcome names zero destination surfaces or more than
one, any plan over 4 KB, and any plan carrying current code state, file:line
references, git workflow or a step list.
Report findings only. Do not rewrite the files.
```

Read the arm's output file, fold the findings into the plan files, then stop.

Output: the paths written and the frontier delta. Nothing else.

## /plans do `<id>`

a. `git checkout -b feat/<slug>` from the current branch's base. The branch carries the descriptor only, no plan id; the index row's branch column is how "which plan was this" gets answered later.

b. `sh scripts/set-row.sh <Project> <id> DOING feat/<slug>`.

c. `sh scripts/log.sh <Project> <id> start feat/<slug>`.

d. Read the plan and its ctx file. Nothing else from `<plans>`, no sibling plans, no `done/`. Then continue under the playbook skill's Backlog item playbook, which owns the destination gate, the probe and the route from here. That skill is user-invoked, so no tool call reaches it and no skill can fire it: open it from disk instead. Read `../playbook/SKILL.md` in full, then `../playbook/playbooks/backlog-item.md`, both relative to this skill's directory, and follow them exactly as if the operator had typed `/playbook`. Do not run the probe here; it runs once, there, after the gate.

The work lands unstaged on that branch. Do not commit it, do not stage it, do not push it, do not open a PR. End by reporting what changed and suggesting one conventional commit message: single line, 50 chars maximum, no body, no trailers, describing the actual change.

## /plans close `<id>`

1. Append a `## Landed` section to the plan file:

```markdown
## Landed

Branch feat/bound-room-fanout, or the SHA once it has been committed.
What actually shipped, in two or three sentences.
Deviations from the Outcome and why the deviation was right.
What was deliberately left, with the id it became if it became one.
```

2. `sh scripts/set-row.sh <Project> <id> DONE - "<note>"` (or `DROPPED`). The note is capped at 100 chars and the script enforces it. If the reason needs more room, that is the signal it belongs in `## Landed`.
3. `git mv` is not involved: `mv "<plans>/<Project>/<id>-<slug>.md" "<plans>/<Project>/done/"`.
4. `sh scripts/log.sh <Project> <id> done "<same short note>"`.

Nothing is deleted. A DROPPED plan keeps its `## Landed` section explaining what made it unnecessary, which is what stops it being re-proposed in six weeks.

## /plans review `<id>`

An automated reviewer comments on the PR and the operator pastes the review into the session. You never fetch it, never reply on the PR, never resolve a thread.

1. Take the pasted comments. Check **both** sources: the inline comments on the diff, and any block in the PR body holding comments that fall outside the diff. The second block is the one that gets missed. If only inline comments were pasted, say so and ask for the body block before starting.
2. Enumerate every comment, inline and outside diff, as a numbered list.
3. For each one: fix it, or dismiss it with a concrete reason (the specific code path, the specific invariant, the specific measurement that makes it wrong). "Not applicable" is not a reason.
4. Report one line per comment: the issue, and the change made for it or why it stands.
5. Where a reply on the PR is warranted (the review is wrong), draft the comment text and hand it over. Short, human, an engineer's quick reply, no over explaining. You do not post it.
6. End with one commit message covering only this round, describing the actual issues fixed, for example `fix: guard null viewer in room block check`. Conventional, single line, 50 chars maximum. Never "resolve comments", "address review" or "fix issues". Do not commit it.

## Sections this format deliberately does not have

- **`## Current state`.** The drift engine. It is a snapshot of the code written at planning time, stale by the time the plan runs, and it teaches executors to trust it over the repo. Intent is durable, state is not. `## Probe` re-derives state at execution time.
- **`## Git workflow`.** Policy lives in the global agent instructions and applies everywhere. Restating it per plan means fifteen copies that can each drift out of agreement with the real rule.
- **`## Drift check`.** Replaced by `## Probe`. A `git diff --stat` against a planning time commit answers "did anything move", which is the wrong question. Ripgrep over symbols answers "is the thing I care about still there and still wrong", which is the question.
- **`## STOP conditions`.** Replaced by probe outcome c. One rule (symbols gone, stop and re-derive) beats a bespoke list per plan that nobody reads to the end.
- **`## Steps`.** The route decides steps at execution time, against the code as it exists then. A step list written days earlier is a guess with authority.
- **`## Commands you will need`.** They live in the acceptance criteria, attached to the claim each one proves, instead of floating in a section with no verdict attached.

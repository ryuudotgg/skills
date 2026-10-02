# Reviewers

A reviewer is a review bot the prs fix round works with, Greptile for example. It ships as an extension skill (`optional: true`, `requires: prs`) whose directory holds a `reviewer.conf`, and that file alone is what makes it a reviewer. Nothing outside a reviewer's own directory spells its login, handle or trigger: shared scripts and agents read declarations through `../bin/skills reviewers`, and the CLI reads them through its one declaration reader.

## The declaration

`reviewer.conf` holds one `KEY=value` per line. Blank lines and `#` lines are skipped. It is read with grep, never sourced.

| key | what it holds |
| --- | --- |
| `NAME` | the display name refusals print, `Greptile` |
| `LOGINS` | every login the bot posts under, space separated, in GraphQL form (`greptile-apps`) and REST form (`greptile-apps[bot]`) |
| `HANDLES` | each mention that summons the bot, space separated |
| `TRIGGER` | the one whole comment body that asks for a re-review, `@greptileai` |
| `CHECK` | the CheckRun or commit status context name, `Greptile Review` |
| `OUTSIDE_DIFF` | optional, the heading a reviewer's outside diff block opens with; non empty when present |
| `SETTING_<NAME>` | a setting's default and allowed pattern, separated by one space |

The first five keys are required, once, and non empty. A login is letters, digits and hyphens, with an optional `[bot]` suffix, and each bot is declared in both forms, plain and `[bot]`, so neither form goes unmatched. Nothing checks that a declared login belongs to a bot: a declaration is trusted like the scripts beside it, and a person's login in `LOGINS` makes that person's comments count as the reviewer's. A handle starts with `@`, and `TRIGGER` starts with one of the reviewer's own handles. A repeated key, a line that isn't `KEY=value`, or any of the rules above broken is a defect. A defect in any installed declaration fails `skills reviewers` for every caller, and each caller then refuses: a broken file never widens what the agent may write.

`skills reviewers [--active] <KEY>` prints `<name>\t<value>` per reviewer, sorted by directory name.

## Settings

`skills reviewers [--active] --settings` prints `<reviewer>\t<setting>\t<default>\t<pattern>` in reviewer directory order and setting declaration order. Setting names are lowercase with hyphens. `--active` keeps only active reviewers.

Each setting key matches `SETTING_[A-Z][A-Z0-9]*(_[A-Z0-9]+)*`. Its default must be non empty and have no whitespace. The pattern after the first space is a JavaScript RegExp that must match the whole value, as if wrapped in `^(?:` and `)$`, and the default must match it. An invalid pattern or two declarations claiming the same skills config key is a defect.

`../bin/skills settings <reviewer>` prints `setting=value` in declaration order. It reads the default from `reviewer.conf`, then `<REVIEWER>_<SETTING>=value` in the skills config, then `git config --local skills.<reviewer>.<setting>` in the current repo. The last valid value wins. A value must be non empty, occur exactly once in its layer, have no CR or newline, and match the whole pattern. Invalid and duplicate values get stderr notes and leave the prior value in place. An inactive reviewer's overrides get notes and do not apply. Unknown settings keys in the skills config get notes.

## Installed and active

**Installed** means the skills tree the playbook resolves to (its real path, so the repo when `install.sh` linked it) holds the reviewer's directory. **Active** means `skills delivery` lists it, which needs prs mode and a `WITH` entry.

| reader | reads | from |
| --- | --- | --- |
| `skills review reply`, `skills review resolve` | `LOGINS` | active reviewers |
| `skills review reply` handle guard | `HANDLES` | every installed reviewer |
| `skills plans below` and `skills plans start`, the `/plans do` preflight | `LOGINS`, for who started the thread | every installed reviewer |
| the comment guard hook | `TRIGGER` | active reviewers, installed ones for the refusal |
| the watcher's review column | `CHECK` | every installed reviewer |

The handle guard reads installed declarations because a mention summons the bot on any repo that runs it, whatever `WITH` lists. The preflight does too, and it looks only at who started a thread: an unresolved thread a reviewer started holds the stack even after a human joined it, or while that reviewer is inactive, until the operator clears it.

`skills review read` and `skills pr watch` read `OUTSIDE_DIFF` from every installed reviewer, active or not.

## Matching

- A login matches exactly, case insensitive. A human named `greptile-fan` is never a reviewer.
- A handle matches anywhere in a body, case insensitive, as a fixed string. `@greptile` catches `@greptileai` and `@greptile-apps`.
- A trigger matches the whole comment body exactly.
- A check matches when its name contains `CHECK`, case insensitive.

## Presence

`../../../src/round/presence.ts` computes the head check, whether the reviewer was seen on the PR, whether it is installed, and the last event from the round's shared PR snapshot. It uses the declaration's `CHECK`, `TRIGGER` and `LOGINS`, and knows no reviewer names. Its fields are `check`, `seen`, `event`, `elapsed`, `age` and `gate`. Each reviewer interprets its own completed check's description or title.

A reviewer was seen when a matching CheckRun or commit status exists on any commit, or one of its logins authored a comment, review, first thread comment or PR body edit. A full page of edits, comments, reviews, threads, commits or contexts also counts as seen because it may hide earlier activity. Check suites never establish presence. A status in `EXPECTED` is a branch protection placeholder and does not match.

A reviewer is installed when a head check suite belongs to its app, the slug of each `LOGINS` entry ending in `[bot]` with that suffix dropped. GitHub creates a queued suite for each installed app with checks access when the head is pushed, before any check run starts, so a suite says the reviewer is set up on the repository, not that it will review. It never counts as seen. A reviewer with no suite on the head reads as not installed.

The last event is the latest of opening, leaving draft, pushing the head and posting the exact trigger. Ties favor the later item in that order. Push time is the earliest head check suite creation time, or the commit date when no suite exists. The newest matching head check supplies its state and age. A completed check older than the last trigger counts as missing when that trigger is the last event.

The appear window is 60 s after the last event. An installed reviewer also gets the start window, 180 s after the latest opening, leaving draft or trigger, when no activity of its own is on the PR, a full page aside, or the last event is a trigger. A push never restarts it, so a reviewer that sat out the start window waits only the appear window after the next push. The pending cap is 20 min of check age. All three are fixed in `../../../src/round/presence.ts`, whose exported `limits` gives their seconds to each reviewer.

The first matching row wins.

| head check | gate result |
| --- | --- |
| pending, under the cap | `wait check-pending` |
| pending, at or past the cap | `unavailable timeout` |
| missing, inside its appear or start window | `wait check-appear` |
| missing after the window, never seen, not installed | `absent` |
| missing after the windows, last event a trigger | `unavailable no-review` |
| missing after the windows, never seen, installed | `unavailable no-start` |
| missing after the window, last event opening, ready or push | the reviewer decides from its latest result |
| completed | the reviewer decides from its result and findings |

`absent` means the reviewer is not set up on this repository, and a reviewer's skill may give it a qualifier, as Greptile's `absent optional` does. Post nothing, including a trigger. `unavailable no-start` means it is set up but did not start on this head in time, out of credit say, so the round goes on without it and the next round reads it again. Each reviewer reads the shared check state once per pass and never waits. The round owns the only poll loop. `gate --wait` repeats passes while the combined word is `wait`; `decide` repeats while the combined word is `wait` and some reviewer reads `wait check-appear`, so a `handback` ends it. Each pass reads every reviewer once. A real clock deadline of the start window plus the cap stops either loop from starting another pass, and the last pass is what prints; it does not cut short a reviewer read already running. `ROUND_POLL` sets the interval in whole seconds, 30 when it is not a positive integer. `REVIEW_NOW` controls fact timestamps for tests, never the deadline.

## The round

`../bin/skills round` is the one entry point babysit and `/plans review` call. Nothing else runs a single reviewer's gate or decide scripts.

```
skills round gate <pr> [--wait] [critical=true]
skills round decide <pr> <branch> [critical=true] [<reviewer>=fixed|<reviewer>=dismissed ...]
```

For each pass the round reads one shared PR snapshot and computes presence for each active reviewer. It passes the snapshot, presence, declaration, settings, limits, phase, outcome and critical flag to that reviewer's pure `facts` function, then calls its pure `decide` with the facts and the same input. `decide` returns one verdict line. Every reviewer ships `reviewer.ts`; `skills check` fails a `reviewer.conf` without it. A reviewer may declare exact `headChecks` names: when the head contexts page is truncated, the snapshot reader fetches those checks once per name and keeps the first page unchanged. The gate phase reads the PR as it stands. The decide phase runs after the round's push and reads the pushed head fresh: a `<reviewer>=` argument names each reviewer whose gate said `triage`, and whether the round fixed at least one of its findings or dismissed them all. Every reviewer whose gate said `triage` gets one, and a triage with no findings counts as `dismissed`. A reviewer with no such argument had nothing triaged, so its decide reruns its gate. Both phases take `critical=true` when the plan's frontmatter says `critical: true`, or when the operator asked for 5/5 on a PR outside `/plans`; each reviewer reads it as its stricter floor.

It prints `<reviewer> <verdict>` per reviewer, then one combined line. With no active reviewer it prints only `done` and calls no `gh`. A missing reviewer module, a function that throws, or a verdict outside the vocabulary reads as `handback refused`, with the reason on stderr after the reviewer's name. A failed `headChecks` read is noted after the check's name. Within one `--wait` or decide loop the snapshot reader keeps the comments it read and fetches earlier comment pages only until it reaches one it already holds, and only while the PR's comment count still matches what it holds; a deleted comment sends it back to the first page. A defective declaration makes the round itself refuse.

**Step aside.** Every reviewer is treated the same, and no setting ranks one above another. `unavailable <reason>` means the reviewer did not review the head and will not, for a reason unrelated to the code, with no retry left. A retryable state is `rereview` while budget remains. An unavailable reviewer steps aside when another reviewer's `done` covers the layer and stays on its own line. Unavailable never hides findings: open findings at or above the floor make that reviewer's verdict `triage`, or `handback` once its budget is spent. `absent` is its own verdict, never an unavailable reason. The gate's `--wait` flag belongs to the round.

**The fold**, over every verdict, first match wins:

| verdicts include | combined |
| --- | --- |
| any `handback` | `handback <reviewer> <reason>`, naming every handback reviewer in reviewer order |
| any `wait` | `wait` |
| any `triage` | `triage` |
| any `rereview` | `rereview` |
| any `done` | `done` |
| any `unavailable` | `handback <reviewer> unavailable <reason>`, naming every unavailable reviewer in reviewer order |
| otherwise, all `absent` or none | `done` |

Reviewer order never changes the verdict word. A `handback` may name several reviewers.

All reviewers being `absent` meets the handoff state, as does one reviewer's `done` when no higher verdict applies. The combined line carries no reason for `done`: a detail the handback must name, Greptile's `done large-fix` say, is on the reviewer's own line.

**Acting on it.**

| combined | babysit, `drive` or `threads-only` | `/plans review` |
| --- | --- | --- |
| `done` | The layer meets the reviewer half of the handoff state. | Nothing more from the reviewers this round. |
| `triage` | After the gate, triage every reviewer line that says `triage` in one fix round. After decide, run the next round. | The same, in this turn. |
| `rereview` | Post the triggers, then run the next round with the gate's `--wait`. | Post the triggers, then run the next round in this turn, gate with `--wait`. |
| `wait` | After the gate, rerun it with `--wait` before triaging, so one fix commit covers every review. After decide, post the triggers, then run the next round with the gate's `--wait`. | After the gate, rerun it with `--wait` before triaging, so one fix commit covers every review. After decide, post the triggers, then run the next round with the gate's `--wait`. |
| `handback` | The layer is not at the handoff state: the babysit stops there. Report the reason. | Report the reason. |

**Triggers.** After decide, and only when the combined line is not a `handback`, post the trigger of each reviewer whose own line says `rereview` as its own command: `gh pr comment <pr> --body "<trigger>"`, the trigger read with `../bin/skills reviewers --active TRIGGER`. A line reading `absent optional` is a reviewer that runs only when asked, with nobody having asked on this PR. Whether to ask is the agent's call under that reviewer's skill; asking posts its trigger the same way and reruns the gate with `--wait`. A trigger is never a question for the operator. The budget, the thresholds and what each verdict reason means stay in the reviewer's own skill.

## Reviewer threads

A reviewer thread is a review thread an active reviewer's login started, in which every comment comes from the active reviewers' combined `LOGINS`. Another bot commenting in it keeps it a reviewer thread. The agent posts as the operator's account, so its reply and a human's look the same: `skills review reply` posts and resolves in one step, and a thread holding any other login is a draft for the operator from then on. A rerun after a reply posted but its resolve failed finds that reply and resolves without posting again. If resolve fails, rerun `skills review reply` with the same body file, not `skills review resolve`. Both verbs read the thread again just before they write, so a comment from anyone outside the reviewers since the first read leaves it open, and two replies to one thread at once post a single reply.

In prs mode, with a reviewer active:

- `../bin/skills review reply <pr> <url> <file>` posts the file as a reply in a reviewer thread and resolves it. It refuses before any write on a resolved thread unless an earlier reply already posted, a thread that is not a reviewer thread, an empty body, or a body naming an installed reviewer's handle.
- `../bin/skills review resolve <pr> <url>...` resolves each reviewer thread a pushed commit fixed and leaves open any with a reply from another login.
- The comment guard lets a top level `gh pr comment <n> --body "<trigger>"` through only for an active reviewer's `TRIGGER`. Whether to spend one is the reviewer skill's decision.

Everything else about publishing is `delivery.md`'s.

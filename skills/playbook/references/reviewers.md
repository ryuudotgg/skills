# Reviewers

A reviewer is a review bot the prs fix round works with, Greptile for example. It ships as an extension skill (`optional: true`, `requires: prs`) whose directory holds a `reviewer.conf`, and that file alone is what makes it a reviewer. Nothing outside a reviewer's own directory spells its login, handle or trigger: every shared script reads them through `../scripts/reviewers.sh`.

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
| `SETTING_<NAME>` | a setting's default and allowed ERE, separated by one space |

The first five keys are required, once, and non empty. A login is letters, digits and hyphens, with an optional `[bot]` suffix, and each bot is declared in both forms, plain and `[bot]`, so neither form goes unmatched. Nothing checks that a declared login belongs to a bot: a declaration is trusted like the scripts beside it, and a person's login in `LOGINS` makes that person's comments count as the reviewer's. A handle starts with `@`, and `TRIGGER` starts with one of the reviewer's own handles. A repeated key, a line that isn't `KEY=value`, or any of the rules above broken is a defect. A defect in any installed declaration fails `reviewers.sh` for every caller, and each caller then refuses: a broken file never widens what the agent may write.

`reviewers.sh [--active] <KEY>` prints `<name>\t<value>` per reviewer, sorted by directory name.

## Settings

`reviewers.sh [--active] --settings` prints `<reviewer>\t<setting>\t<default>\t<ERE>` in reviewer directory order and setting declaration order. Setting names are lowercase with hyphens. `--active` keeps only active reviewers.

Each setting key matches `SETTING_[A-Z][A-Z0-9]*(_[A-Z0-9]+)*`. Its default must be non empty, have no whitespace, and full match the ERE after the first space. An invalid ERE or two declarations claiming the same skills config key is a defect.

`../scripts/settings.sh <reviewer>` prints `setting=value` in declaration order. It reads the default from `reviewer.conf`, then `<REVIEWER>_<SETTING>=value` in the skills config, then `git config --local skills.<reviewer>.<setting>` in the current repo. The last valid value wins. A value must be non empty, occur exactly once in its layer, have no CR or newline, and full match the ERE. Invalid and duplicate values get stderr notes and leave the prior value in place. An inactive reviewer's overrides get notes and do not apply. Unknown settings keys in the skills config get notes.

## Installed and active

**Installed** means the skills tree the playbook resolves to (its real path, so the repo when `install.sh` linked it) holds the reviewer's directory. **Active** means `delivery-mode.sh` lists it, which needs prs mode and a `WITH` entry.

| reader | reads | from |
| --- | --- | --- |
| `reply.sh`, `resolve.sh` | `LOGINS` | active reviewers |
| `reply.sh` handle guard | `HANDLES` | every installed reviewer |
| `below.sh`, the `/plans do` preflight | `LOGINS`, for who started the thread | every installed reviewer |
| the comment guard hook | `TRIGGER` | active reviewers, installed ones for the refusal |
| the watcher's review column | `CHECK` | every installed reviewer |

The handle guard reads installed declarations because a mention summons the bot on any repo that runs it, whatever `WITH` lists. The preflight does too, and it looks only at who started a thread: an unresolved thread a reviewer started holds the stack even after a human joined it, or while that reviewer is inactive, until the operator clears it.

`review-read.sh` and `watch-pr` read `OUTSIDE_DIFF` from every installed reviewer, active or not.

## Matching

- A login matches exactly, case insensitive. A human named `greptile-fan` is never a reviewer.
- A handle matches anywhere in a body, case insensitive, as a fixed string. `@greptile` catches `@greptileai` and `@greptile-apps`.
- A trigger matches the whole comment body exactly.
- A check matches when its name contains `CHECK`, case insensitive.

## Presence

`../scripts/check-state.sh <pr> <check> <trigger> <logins>` reads the head check, whether the reviewer was seen on the PR, and the last event. Pass the declaration's `CHECK`, `TRIGGER` and space separated `LOGINS` as quoted arguments. The reader knows no reviewer names. Each reviewer interprets its own completed check's description or title.

A reviewer was seen when a matching CheckRun or commit status exists on any commit, or one of its logins authored a comment, review, first thread comment or PR body edit. A full page of edits, comments, reviews, threads, commits or contexts also counts as seen because it may hide earlier activity. Check suites never establish presence. A status in `EXPECTED` is a branch protection placeholder and does not match.

The last event is the latest of opening, leaving draft, pushing the head and posting the exact trigger. Ties favor the later item in that order. Push time is the earliest head check suite creation time, or the commit date when no suite exists. The newest matching head check supplies its state and age. A completed check older than the last trigger counts as missing when that trigger is the last event.

The appear window is 60 s after the last event; the pending cap is 20 min of check age. Both are fixed in `check-state.sh`, whose `--limits` prints their seconds for callers.

| head check | gate result |
| --- | --- |
| pending, under the cap | `wait check-pending` |
| pending, at or past the cap | `unavailable timeout` |
| missing, inside the appear window | `wait check-appear` |
| missing after the window, never seen | `absent` |
| missing after the window, last event a trigger | `unavailable no-review` |
| missing after the window, last event opening, ready or push | the reviewer decides from its latest result |
| completed | the reviewer decides from its result and findings |

`absent` means the reviewer has nothing to say on this PR. Post nothing, including a trigger. Each verdict adapter reads the shared check state once and never waits. `round.sh` owns the only poll loop. `gate --wait` repeats passes while the combined word is `wait`; `decide` repeats while the combined word is `wait` and some reviewer reads `wait check-appear`, so a `handback` ends it. Each pass reads every reviewer once. A real clock deadline of window plus cap stops either loop from starting another pass, and the last pass is what prints; it does not cut short a reviewer read already running. `ROUND_POLL` sets the interval in whole seconds, 30 when it is not a positive integer. `REVIEW_NOW` controls fact timestamps for tests, never the deadline.

## The round

`../scripts/round.sh` is the one entry point babysit and `/plans review` call. Nothing else runs a single reviewer's gate or decide scripts.

```
round.sh gate <pr> [--wait] [critical=true]
round.sh decide <pr> <branch> [critical=true] [<reviewer>=fixed|<reviewer>=dismissed ...]
```

For each active reviewer it runs `<reviewer>/scripts/verdict.sh` with the same phase. That script is the reviewer's own adapter over its gate and decide scripts, and every reviewer ships one; `scripts/validate.py` fails a `reviewer.conf` without it. It prints one verdict line. The gate phase reads the PR as it stands. The decide phase runs after the round's push and reads the pushed head fresh: a `<reviewer>=` argument names each reviewer whose gate said `triage`, and whether the round fixed at least one of its findings or dismissed them all. Every reviewer whose gate said `triage` gets one, and a triage with no findings counts as `dismissed`. A reviewer with no such argument had nothing triaged, so its decide reruns its gate. Both phases take `critical=true` when the plan's frontmatter says `critical: true`, or when the operator asked for 5/5 on a PR outside `/plans`; each reviewer reads it as its stricter floor.

It prints `<reviewer> <verdict>` per reviewer, then one combined line. With no active reviewer it prints only `done` and calls no `gh`. A reviewer script that fails or prints anything outside the verdict vocabulary reads as `handback refused`, its stderr passed through. A defective declaration makes `round.sh` itself refuse.

**Step aside.** Every reviewer is treated the same, and no setting ranks one above another. `unavailable <reason>` means the reviewer did not review the head and will not, for a reason unrelated to the code, with no retry left. A retryable state is `rereview` while budget remains. An unavailable reviewer steps aside when another reviewer's `done` covers the layer and stays on its own line. Unavailable never hides findings: open findings at or above the floor make that reviewer's verdict `triage`, or `handback` once its budget is spent. `absent` is its own verdict, never an unavailable reason. The gate's `--wait` flag belongs to `round.sh`.

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

**Triggers.** After decide, and only when the combined line is not a `handback`, post the trigger of each reviewer whose own line says `rereview` as its own command: `gh pr comment <pr> --body "<trigger>"`, the trigger read with `../scripts/reviewers.sh --active TRIGGER`. A trigger is never a question for the operator. The budget, the thresholds and what each verdict reason means stay in the reviewer's own skill.

## Reviewer threads

A reviewer thread is a review thread an active reviewer's login started, in which every comment comes from the active reviewers' combined `LOGINS`. Another bot commenting in it keeps it a reviewer thread. The agent posts as the operator's account, so its reply and a human's look the same: `reply.sh` posts and resolves in one step, and a thread holding any other login is a draft for the operator from then on.

In prs mode, with a reviewer active:

- `../scripts/reply.sh <pr> <url> <file>` posts the file as a reply in a reviewer thread and resolves it. It refuses before any write on a resolved thread, a thread that is not a reviewer thread, an empty body, or a body naming an installed reviewer's handle.
- `../scripts/resolve.sh <pr> <url>...` resolves each reviewer thread a pushed commit fixed and leaves open any with a reply from another login.
- The comment guard lets a top level `gh pr comment <n> --body "<trigger>"` through only for an active reviewer's `TRIGGER`. Whether to spend one is the reviewer skill's decision.

Everything else about publishing is `delivery.md`'s.
